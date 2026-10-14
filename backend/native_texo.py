"""Texo ONNX on OpenVINO. Static vision encoder, cached CPU autoregressive decoder."""
from pathlib import Path
try:
    from .cache_lease import cache_user
except ImportError:
    from cache_lease import cache_user
import base64
import hashlib
import io
import json
import os
import struct
import time
try:
    from .managed_store import managed_directory
except ImportError:
    from managed_store import managed_directory
import numpy as np
from PIL import Image, UnidentifiedImageError
import openvino as ov
from tokenizers import Tokenizer
from openvino import opset13 as ops
from openvino.passes import Manager, ConstantFolding

FILES = ('config.json', 'tokenizer.json', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx')


def model_directory():
    """Reuse prepared weights; packaged builds extract only Texo from their ASAR, once."""
    root = Path(__file__).resolve().parent.parent
    configured = os.environ.get('SURFACETAB_TEXO_DIR')
    if configured:
        candidates = [Path(configured)]
    else:
        managed = managed_directory('texo', 'b2668efe5112082846fde4d446b9bfaab3989533', 'texo')
        candidates = ([managed] if managed else []) + [root / 'public/models/texo', root / 'dist/models/texo']
    for folder in candidates:
        if all((folder / name).is_file() for name in FILES):
            manifest = json.loads((folder / 'manifest.json').read_text('utf-8'))
            verify_files(folder, manifest)
            return folder
    if configured:
        raise ValueError('SURFACETAB_TEXO_DIR does not contain prepared Texo weights')
    archive = root / 'resources/app.asar'
    with archive.open('rb') as stream:
        prefix = stream.read(16)
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size < header_size <= 8_000_000:
            raise ValueError('Invalid packaged model header')
        header = json.loads(stream.read(json_size))

        def read(name):
            entry = header
            for part in ('dist/models/texo/' + name).split('/'):
                entry = entry['files'][part]
            size = int(entry['size'])
            if size > 128_000_000 or entry.get('unpacked'):
                raise ValueError('Invalid packaged model entry')
            stream.seek(8 + header_size + int(entry['offset']))
            data = stream.read(size)
            if len(data) != size:
                raise ValueError('Incomplete packaged model')
            return data

        manifest = json.loads(read('manifest.json'))
        revision = manifest['revision']
        if not isinstance(revision, str) or not revision.isalnum():
            raise ValueError('Invalid model revision')
        folder = Path(os.environ.get('LOCALAPPDATA', str(root / '.cache'))) / 'SurfaceTab/native-models' / revision
        for name in (*FILES, 'manifest.json'):
            destination = folder / name
            expected = next((f for f in manifest['files'] if f['name'] == name), None)
            if expected and destination.is_file() and valid_file(destination, expected):
                continue
            data = read(name)
            if expected and (len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']):
                raise ValueError('Packaged model checksum mismatch: ' + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(destination)
        verify_files(folder, manifest)
        return folder


def valid_file(path, record):
    return path.stat().st_size == record['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest() == record['sha256']


def verify_files(folder, manifest):
    for name in FILES:
        entry = next((f for f in manifest['files'] if f['name'] == name), None)
        if entry is None or not valid_file(folder / name, entry):
            raise ValueError('Texo model checksum mismatch: ' + name)


def image_pixels(data):
    if not data.startswith('data:image/png;base64,') or len(data) > 4_000_000:
        raise ValueError('Only PNG images up to 4 MB are accepted')
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data.split(',', 1)[1], validate=True)))
        if image.format != 'PNG':
            raise ValueError('Only PNG images are accepted')
        if image.width * image.height > 4_000_000:
            raise ValueError('Image exceeds 4 million pixels')
        rgba = image.convert('RGBA')
        image = Image.new('RGBA', rgba.size, 'white')
        image.alpha_composite(rgba)
        rgb = np.asarray(image.convert('RGB'), dtype=np.float32)
        gray = rgb @ np.array([.299, .587, .114], np.float32)
        ys, xs = np.where(gray < 200)
        if not len(xs):
            raise ValueError('The drawing is empty')
        crop = image.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)).convert('RGB')
        factor = 384 / max(crop.size)
        size = (max(1, int(crop.width * factor + .5)), max(1, int(crop.height * factor + .5)))
        resized = crop.resize(size, Image.Resampling.BILINEAR)
        output = Image.new('RGB', (384, 384), 'black')
        output.paste(resized, ((384 - size[0]) // 2, (384 - size[1]) // 2))
        gray = np.asarray(output, dtype=np.float32) @ np.array([.299, .587, .114], np.float32)
        normalized = (gray / 255 - .7931) / .1738
        return np.repeat(normalized[None, None, :, :], 3, axis=1)
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError('Invalid PNG image') from error


@cache_user
class NativeTexo:
    def __init__(self, folder=None):
        self.folder = Path(folder) if folder else model_directory()
        self.core = ov.Core()
        cache = Path(os.environ.get('LOCALAPPDATA', str(self.folder.parent))) / 'SurfaceTab/openvino-cache' / ov.__version__.split('-')[0]
        cache.mkdir(parents=True, exist_ok=True)
        self.core.set_property({'CACHE_DIR': str(cache)})
        self.encoder = None
        self.decoder = None
        self.encoder_device = ''
        self.tokenizer = Tokenizer.from_file(str(self.folder / 'tokenizer.json'))
        self.failures = {}
        self.retry_after = {}

    def devices(self):
        return [{'id': d, 'name': self.core.get_property(d, 'FULL_DEVICE_NAME')} for d in self.core.available_devices]

    def prepare(self, requested='AUTO'):
        if requested not in ('AUTO', 'CPU', 'GPU', 'NPU'):
            raise ValueError('Invalid device')
        choices = ['NPU', 'GPU', 'CPU'] if requested == 'AUTO' else [requested, 'CPU']
        start = time.perf_counter()
        if self.decoder is None:
            decoders = {}
            # Constant cache branches give If outputs a known rank. The original
            # merged graph has dynamic-rank empty cross-cache outputs unsupported
            # by the CPU plugin. Both graphs keep the original weights/operations.
            for cached in (False, True):
                decoder = self.core.read_model(self.folder / 'onnx/decoder_model_merged.onnx')
                branch = next(p for p in decoder.get_parameters() if p.output(0).get_any_name() == 'use_cache_branch')
                branch.output(0).replace(ops.constant([cached]).output(0))
                decoder.remove_parameter(branch)
                passes = Manager(); passes.register_pass(ConstantFolding()); passes.run_passes(decoder)
                decoders[cached] = self.core.compile_model(decoder, 'CPU', {'PERFORMANCE_HINT': 'LATENCY', 'INFERENCE_NUM_THREADS': 2, 'INFERENCE_PRECISION_HINT': 'f32'})
            self.decoder = decoders
        for device in dict.fromkeys(choices):
            if device not in self.core.available_devices:
                self.failures[device] = 'Device is unavailable'
                continue
            if self.encoder is not None and self.encoder_device == device:
                break
            if time.monotonic() < self.retry_after.get(device, 0):
                continue
            try:
                encoder = self.core.read_model(self.folder / 'onnx/encoder_model.onnx')
                encoder.reshape({'pixel_values': [1, 3, 384, 384]})
                config = {'PERFORMANCE_HINT': 'LATENCY'}
                if device == 'CPU':
                    config.update(INFERENCE_NUM_THREADS=2, INFERENCE_PRECISION_HINT='f32')
                self.encoder = self.core.compile_model(encoder, device, config)
                self.encoder_device = device
                self.failures.pop(device, None)
                break
            except Exception as error:
                self.failures[device] = str(error)[:1500]
                self.retry_after[device] = time.monotonic() + 300
        else:
            raise RuntimeError('No compatible Texo encoder device')
        return (time.perf_counter() - start) * 1000

    def recognize(self, image, device='AUTO', max_tokens=256, cancelled=None):
        pixels = image_pixels(image)
        started = time.perf_counter()
        compile_ms = self.prepare(device)
        if cancelled and cancelled.is_set():
            raise InterruptedError('Formula recognition cancelled')
        t = time.perf_counter()
        for attempt in range(3):
            if cancelled and cancelled.is_set():
                raise InterruptedError('Formula recognition cancelled')
            try:
                states = np.array(self.encoder({'pixel_values': pixels})[0], copy=True)
                break
            except Exception as error:
                self.failures[self.encoder_device] = str(error)[:1500]
                self.retry_after[self.encoder_device] = time.monotonic() + 300
                self.encoder = None
                # AUTO keeps the same power-first sequence after runtime faults.
                compile_ms += self.prepare(device)
        else:
            raise RuntimeError('No compatible Texo encoder device')
        encoder_ms = (time.perf_counter() - t) * 1000
        tokens = [0]
        cache = {f'past_key_values.{layer}.{kind}.{value}': np.zeros((1, 16, 0, 24), np.float32)
                 for layer in range(2) for kind in ('decoder', 'encoder') for value in ('key', 'value')}
        t = time.perf_counter()
        deadline = time.monotonic() + 120
        # Input names are fixed per decoder graph; resolve them once, not per token.
        needed = {flag: {p.get_any_name() for p in self.decoder[flag].inputs} for flag in (False, True)}
        for step in range(max_tokens):
            if cancelled and cancelled.is_set():
                raise InterruptedError('Formula recognition cancelled')
            if time.monotonic() > deadline:
                raise RuntimeError('Formula inference timed out')
            feeds = {'input_ids': np.array([[tokens[-1]]], dtype=np.int64), 'encoder_hidden_states': states,
                     'use_cache_branch': np.array([step > 0], dtype=np.bool_), **cache}
            decoder = self.decoder[step > 0]
            result = decoder({k: v for k, v in feeds.items() if k in needed[step > 0]})
            # Only the cache tensors outlive this step; logits are read in place.
            output = {}
            for port, value in result.items():
                name = port.get_any_name()
                if name == 'logits':
                    token = int(value[0, -1].argmax())
                else:
                    output[name] = np.array(value, copy=True)
            tokens.append(token)
            if token == 2:
                break
            for key in cache:
                value = output[key.replace('past_key_values.', 'present.')]
                if '.encoder.' not in key or step == 0:
                    cache[key] = value
        decoder_ms = (time.perf_counter() - t) * 1000
        if tokens[-1] != 2:
            raise ValueError('Formula exceeded the 256 token limit; rewrite it or select a smaller region')
        return {'latex': self.tokenizer.decode(tokens, skip_special_tokens=True), 'engine': 'Texo OpenVINO',
                'encoderDevice': self.encoder_device, 'decoderDevice': 'CPU', 'requestedDevice': device,
                'fallback': self.encoder_device != ('NPU' if device == 'AUTO' else device), 'failures': self.failures.copy(),
                'timing': {'totalMs': (time.perf_counter() - started) * 1000, 'compileMs': compile_ms,
                           'encoderMs': encoder_ms, 'decoderMs': decoder_ms}, 'tokens': len(tokens) - 1}
