"""PP-OCRv4 on Intel devices, with RapidOCR 3.10.0 preprocessing/postprocessing.

RapidOCR and upstream PaddleOCR components are Apache-2.0 licensed. Custom
initialization injects bounded sessions without modifying library globals or
constructing its default CPU sessions. Recognition splits before the 6625-way
projection for NPU memory compatibility; weights and operations are unchanged.
"""
import base64
import io
import os
import re
import time
import weakref
from collections import OrderedDict
from pathlib import Path
import cv2
import numpy as np
import openvino as ov
from PIL import Image, UnidentifiedImageError
from rapidocr import RapidOCR
from rapidocr.ch_ppocr_det import TextDetector
from rapidocr.ch_ppocr_det.utils import DBPostProcess
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.utils import CTCLabelDecode
from rapidocr.ch_ppocr_cls import TextClassifier
from rapidocr.ch_ppocr_cls.utils import ClsPostProcess
from rapidocr.utils.typings import EngineType, OCRVersion, ModelType
try:
    from .ocr_store import FILES, model_directory
    from .opus_cache import trim_cache
except ImportError:
    from ocr_store import FILES, model_directory
    from opus_cache import trim_cache

CPU_CONFIG = {'PERFORMANCE_HINT': 'LATENCY', 'INFERENCE_NUM_THREADS': 2,
              'NUM_STREAMS': 1, 'INFERENCE_PRECISION_HINT': 'f32'}
MEAN, STD = [.485, .456, .406], [.229, .224, .225]
REC_BUCKETS = (320, 640, 1280)
CACHE_BUDGET = 256 * 1024 * 1024
MAX_COMPILED = 6
MAX_SIDE = 2 * 768 - 64  # At most four overlapping detector tiles per region.


def read_image(data):
    if not data.startswith('data:image/png;base64,') or len(data) > 4_000_000:
        raise ValueError('Only PNG images up to 4 MB are accepted')
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data.split(',', 1)[1], validate=True)))
        if image.format != 'PNG' or image.width * image.height > 4_000_000 or max(image.size) > 8192:
            raise ValueError('PNG image exceeds 4 million pixels')
        if max(image.size) / min(image.size) > 256:
            raise ValueError('Image is too narrow; select a larger region')
        rgba = image.convert('RGBA')
        background = Image.new('RGBA', rgba.size, 'white')
        background.alpha_composite(rgba)
        return np.asarray(background.convert('RGB'))[:, :, ::-1].copy()
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError('Invalid PNG image') from error


def split_recognition(model):
    """Validate the fixed head, preserving its MatMul/Add/Softmax exactly."""
    model = model.clone()
    softmax = model.output(0).get_node().input_value(0).get_node()
    if softmax.get_type_name() != 'Softmax':
        raise RuntimeError('Unexpected OCR recognition output')
    bias = softmax.input_value(0).get_node()
    mm = bias.input_value(0).get_node()
    if bias.get_type_name() != 'Add' or mm.get_type_name() != 'MatMul' or list(mm.input_value(1).shape) != [120, 6625]:
        raise RuntimeError('Unexpected OCR recognition head')
    feature = mm.input_value(0)
    backbone = ov.Model([feature], model.get_parameters())
    shape = ov.PartialShape(feature.partial_shape)
    shape[0] = 1
    parameter = ov.opset13.parameter(shape, np.float32)
    mm.input(0).replace_source_output(parameter.output(0))
    head = ov.Model(model.outputs, [parameter])
    return backbone, head


class OcrSession:
    def __init__(self, owner, stage):
        self.owner, self.stage = weakref.ref(owner), stage

    def __call__(self, pixels):
        owner = self.owner()
        if owner is None:
            raise RuntimeError('OCR session has been released')
        return owner.infer(self.stage, pixels)


class BoundedDetector(TextDetector):
    def __call__(self, image):
        if max(image.shape[:2]) <= 768:
            result = super().__call__(image)
        else:
            # Preserve small text instead of shrinking a wide region/page to
            # 768px. Merge probability maps before finding boxes, so overlapping
            # tiles do not duplicate text or break a line at a tile boundary.
            from rapidocr.ch_ppocr_det.utils import TextDetOutput
            start = time.perf_counter()
            height, width = image.shape[:2]
            merged = np.zeros((1, 1, height, width), np.float32)
            self.preprocess_op = self.get_preprocess()
            def positions(length):
                if length <= 768:
                    return [0]
                return sorted(set([*range(0, length - 768, 704), length - 768]))
            for y in positions(height):
                for x in positions(width):
                    tile = image[y:y + 768, x:x + 768]
                    inputs = self.preprocess_op(tile)
                    if inputs is None:
                        continue
                    probability = self.session(inputs)[0, 0]
                    probability = cv2.resize(probability, (tile.shape[1], tile.shape[0]))
                    target = merged[0, 0, y:y + tile.shape[0], x:x + tile.shape[1]]
                    np.maximum(target, probability, out=target)
            boxes, scores = self.postprocess_op(merged, (height, width))
            result = TextDetOutput(image, self.sorted_boxes(boxes), scores, elapse=time.perf_counter() - start) if len(boxes) else TextDetOutput()
        if result.boxes is not None and len(result.boxes) > 128:
            raise ValueError('Too many text regions; select a smaller area')
        return result


try:
    from .cache_lease import cache_user
except ImportError:
    from cache_lease import cache_user


@cache_user
class NativeOcr:
    def __init__(self, folder=None):
        self.folder = Path(folder) if folder else model_directory()
        self.core = ov.Core()
        base = Path(os.environ.get('SURFACETAB_OCR_CACHE', str(Path(os.environ.get('LOCALAPPDATA', str(self.folder.parent))) / 'SurfaceTab/ocr-openvino-cache')))
        self.cache_dir = base / 'ppocrv4-split-v1' / re.sub(r'[^a-zA-Z0-9._-]', '_', ov.__version__)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        trim_cache(self.cache_dir, CACHE_BUDGET)
        self.core.set_property({'CACHE_DIR': str(self.cache_dir)})
        self.graphs = {stage: self.core.read_model(self.folder / name) for stage, name in zip(('det', 'rec', 'cls'), FILES)}
        self.backbone, self.head_graph = split_recognition(self.graphs['rec'])
        self.compiled, self.failed, self.failures = OrderedDict(), {}, {}
        self.head = None
        self.encoder_device = ''
        self.ocr = self.make_pipeline()
        cv2.setNumThreads(1)

    def make_pipeline(self):
        pipeline = RapidOCR(params={'Global.log_level': 'error', 'Global.max_side_len': MAX_SIDE, 'Global.min_side_len': 1,
            'Det.ocr_version': OCRVersion.PPOCRV4, 'Rec.ocr_version': OCRVersion.PPOCRV4,
            'Det.model_type': ModelType.MOBILE, 'Rec.model_type': ModelType.MOBILE,
            'Det.engine_type': EngineType.OPENVINO, 'Rec.engine_type': EngineType.OPENVINO,
            'Cls.engine_type': EngineType.OPENVINO, 'Rec.rec_batch_num': 1})
        # These initializers only configure the pinned library's preprocessing;
        # inference always uses our sessions, with no downloader/default models.
        detector = BoundedDetector.__new__(BoundedDetector)
        detector.limit_side_len, detector.limit_type = 768, 'max'
        detector.mean, detector.std, detector.preprocess_op = MEAN, STD, None
        detector.postprocess_op = DBPostProcess(thresh=.3, box_thresh=.5, max_candidates=1000,
                                              unclip_ratio=1.6, use_dilation=True, score_mode='fast')
        detector.session = OcrSession(self, 'det')
        recognizer = TextRecognizer.__new__(TextRecognizer)
        characters = self.graphs['rec'].get_rt_info()['framework']['character'].value.splitlines()
        recognizer.postprocess_op = CTCLabelDecode(character=characters)
        if len(recognizer.postprocess_op.character) != 6625:
            raise RuntimeError('Unexpected OCR character dictionary')
        recognizer.rec_batch_num, recognizer.rec_image_shape = 1, [3, 48, 320]
        pipeline.cfg.Rec.font_path = None
        recognizer.cfg, recognizer.session = pipeline.cfg.Rec, OcrSession(self, 'rec')
        classifier = TextClassifier.__new__(TextClassifier)
        classifier.cls_image_shape, classifier.cls_batch_num, classifier.cls_thresh = [3, 48, 192], 6, .9
        classifier.postprocess_op, classifier.session = ClsPostProcess(['0', '180']), OcrSession(self, 'cls')
        pipeline.text_det, pipeline.text_rec, pipeline.text_cls = detector, recognizer, classifier
        return pipeline

    def check(self):
        if self.cancelled is not None and self.cancelled.is_set():
            raise InterruptedError()
        if time.monotonic() > self.deadline:
            raise TimeoutError('OCR exceeded 120 seconds')

    def compile(self, stage, device, shape):
        key = stage, device, tuple(shape) if device != 'CPU' else 'dynamic'
        if key in self.compiled:
            self.compiled.move_to_end(key)
            return self.compiled[key]
        self.check()
        if len(self.compiled) >= MAX_COMPILED:
            self.compiled.popitem(last=False)
        model = (self.backbone if stage == 'rec' and device != 'CPU' else self.graphs[stage]).clone()
        model.reshape(shape if device != 'CPU' else [-1, 3, 48 if stage == 'rec' else -1, -1])
        start = time.perf_counter()
        config = CPU_CONFIG if device == 'CPU' else {'PERFORMANCE_HINT': 'LATENCY'}
        if device == 'GPU':
            config = {**config, 'INFERENCE_PRECISION_HINT': 'f16'}
        trim_cache(self.cache_dir, CACHE_BUDGET)
        compiled = self.core.compile_model(model, device, config)
        if stage == 'rec' and device != 'CPU' and self.head is None:
            self.head = self.core.compile_model(self.head_graph, 'CPU', CPU_CONFIG)
        self.compile_ms += (time.perf_counter() - start) * 1000
        trim_cache(self.cache_dir, CACHE_BUDGET)
        self.check()
        self.compiled[key] = compiled
        return compiled

    def infer(self, stage, pixels):
        self.check()
        if stage == 'rec' and pixels.shape[3] > 4096:
            raise ValueError('Text line is too long; select a smaller area')
        choices = ['CPU'] if stage == 'cls' else ['NPU', 'GPU', 'CPU'] if self.requested == 'AUTO' else list(dict.fromkeys([self.requested, 'CPU']))
        error = None
        for device in choices:
            self.check()
            if device not in self.core.available_devices:
                continue
            shape = list(pixels.shape)
            if device != 'CPU':
                if stage == 'det':
                    shape = [1, 3, 768, 768]
                elif stage == 'rec':
                    width = next((n for n in REC_BUCKETS if n >= pixels.shape[3]), None)
                    if width is None:
                        continue  # No truncation/rescaling of long text: use CPU.
                    shape = [1, 3, 48, width]
            key = stage, device, tuple(shape) if device != 'CPU' else 'dynamic'
            if self.failed.get(key, 0) > time.monotonic():
                continue
            try:
                compiled = self.compile(stage, device, shape)
                self.check()
                padded = pixels
                if tuple(shape) != pixels.shape:
                    padded = np.zeros(shape, np.float32)
                    if stage == 'det':
                        for c in range(3):
                            padded[:, c, :, :] = (1 - MEAN[c]) / STD[c]
                    padded[:, :, :pixels.shape[2], :pixels.shape[3]] = pixels
                start = time.perf_counter()
                output = compiled([padded])[0].copy()
                self.check()
                if stage == 'rec' and device != 'CPU':
                    output = self.head([output])[0].copy()
                if stage == 'det' and device != 'CPU':
                    output = output[:, :, :pixels.shape[2], :pixels.shape[3]]
                if not np.isfinite(output).all():
                    raise RuntimeError('Non-finite OCR output')
                self.stage_ms[stage] += (time.perf_counter() - start) * 1000
                self.used[stage].add(device)
                if stage == 'det':
                    self.encoder_device = device
                self.check()
                return output
            except (InterruptedError, TimeoutError, ValueError):
                raise
            except Exception as exc:
                self.failed[key] = time.monotonic() + 300
                self.failures[str(key)] = str(exc)[-500:]
                self.compiled.pop(key, None)
                error = exc
        raise RuntimeError('OCR stage unavailable: ' + stage) from error

    def recognize(self, image, device='AUTO', cancelled=None):
        if device not in ('AUTO', 'CPU', 'GPU', 'NPU'):
            raise ValueError('Invalid device')
        start = time.perf_counter()
        self.requested, self.cancelled, self.deadline = device, cancelled, time.monotonic() + 120
        self.compile_ms = 0
        self.stage_ms, self.used = {s: 0 for s in ('det', 'rec', 'cls')}, {s: set() for s in ('det', 'rec', 'cls')}
        self.check()
        pixels = read_image(image)
        self.check()
        result = self.ocr(pixels)
        self.check()
        text = '\n'.join(value.strip() for value in (result.txts or []) if value.strip())
        scores = result.scores or []
        actual = {stage: sorted(devices) for stage, devices in self.used.items()}
        lines = []
        if result.boxes is not None:
            for i, (value, box) in enumerate(zip(result.txts or [], result.boxes)):
                polygon = np.asarray(box, dtype=float).reshape(-1)
                if value.strip() and polygon.size == 8 and np.isfinite(polygon).all():
                    lines.append({'text': value.strip(), 'polygon': polygon.tolist(),
                                  'confidence': float(scores[i] * 100) if i < len(scores) else 0})
        return {'text': text, 'confidence': float(np.mean(scores) * 100) if scores else 0,
                'lines': lines,
                'engine': 'PP-OCRv4 OpenVINO', 'devices': actual, 'projectionDevice': 'CPU',
                'fallback': device != 'CPU' and any('CPU' in self.used[s] for s in ('det', 'rec')),
                'timing': {'totalMs': (time.perf_counter() - start) * 1000, 'compileMs': self.compile_ms,
                           'stageMs': self.stage_ms}, 'compiledSessions': len(self.compiled) + int(self.head is not None)}
