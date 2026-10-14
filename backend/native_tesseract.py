"""Optional English Tesseract NPU: CPU layout boxes, bounded line pipeline.

No downloads or model initialization on import. Neural inference never falls
back to CPU. A scan owns only one bitmap and at most 16 normalized line inputs.
"""
import asyncio
import base64
from io import BytesIO
from pathlib import Path
import os
import hashlib
import json
import struct
import time

from PIL import Image

try:
    from .managed_store import managed_directory
    from .cache_lease import cache_user
    from .experimental.tesseract_pipeline import BatchRecognizer, run_pipeline
    from .experimental.tesseract_graph import prepare_line, PINNED
except ImportError:
    from managed_store import managed_directory
    from cache_lease import cache_user
    from experimental.tesseract_pipeline import BatchRecognizer, run_pipeline
    from experimental.tesseract_graph import prepare_line, PINNED

REVISION = 'englishqueuev1'


def model_path(variant):
    if variant not in ('fast', 'best', 'mixed-best'):
        raise ValueError('Invalid Tesseract variant')
    family = 'tesseract-openvino-zh' if variant == 'mixed-best' else 'tesseract-openvino'
    revision = 'mixedqueuev1' if variant == 'mixed-best' else REVISION
    root = Path(__file__).resolve().parent.parent
    managed = managed_directory(family, revision, family)
    configured = os.environ.get('TIXTAB_TESSERACT_DIR')
    folders = ([Path(configured)] if configured else
               [managed, root / 'public/models' / family,
                root / 'dist/models' / family])
    for folder in folders:
        if folder and (folder / (variant + '.traineddata')).is_file():
            return folder / (variant + '.traineddata')
    archive = root / 'resources/app.asar'
    if archive.is_file() and not configured:
        return extract_bundled(archive, variant)
    raise ValueError('Install the selected Tesseract model in local model management')


def extract_bundled(archive, variant):
    family = 'tesseract-openvino-zh' if variant == 'mixed-best' else 'tesseract-openvino'
    revision = 'mixedqueuev1' if variant == 'mixed-best' else REVISION
    folder = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'SurfaceTab/native-models' / family / revision
    target = folder / (variant + '.traineddata')
    size = {'fast':4113088, 'best':15400601, 'mixed-best':13077423}[variant]
    if target.is_file() and target.stat().st_size == size:
        # The parser verifies the pinned hash before loading, including copies.
        return target
    with archive.open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError('Invalid packaged model header')
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size < header_size <= 8_000_000:
            raise ValueError('Invalid packaged model header')
        entry = json.loads(stream.read(json_size))
        try:
            for part in ('dist/models/' + family + '/' + variant + '.traineddata').split('/'):
                entry = entry['files'][part]
        except KeyError as error:
            raise ValueError('Install Tesseract English Fast + Best in local model management') from error
        if entry.get('unpacked') or entry.get('size') != size or int(entry['offset']) < 0:
            raise ValueError('Invalid packaged model entry')
        stream.seek(8 + header_size + int(entry['offset']))
        folder.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.tmp')
        try:
            digest, remaining = hashlib.sha256(), size
            with temporary.open('wb') as out:
                while remaining:
                    chunk = stream.read(min(remaining, 1024*1024))
                    if not chunk:
                        raise ValueError('Incomplete packaged model')
                    out.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if digest.hexdigest() != PINNED[variant]:
                raise ValueError('Packaged model checksum mismatch')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


@cache_user
class NativeTesseract:
    encoder_device = 'NPU'

    def __init__(self, variant, batch):
        self.variant = variant
        self.engine = BatchRecognizer(model_path(variant), variant, 'NPU', batch)

    def close(self):
        if self.engine:
            self.engine.close()
            self.engine = None

    def recognize(self, image, boxes, cancelled):
        started = time.perf_counter()
        compilation_start = len(self.engine.compilations)
        if cancelled.is_set():
            raise InterruptedError()
        if not image.startswith('data:image/png;base64,'):
            raise ValueError('PNG input required')
        raw = base64.b64decode(image.split(',', 1)[1], validate=True)
        source = None
        try:
            with BytesIO(raw) as buffer, Image.open(buffer) as original:
                if original.width * original.height > 4_000_000:
                    raise ValueError('Image exceeds 4 million pixels')
                source = original.convert('L')
            raw = None
            width, height = source.size
            input_height = 48 if self.variant == 'mixed-best' else 36
            lines = []
            for box in boxes:
                x0, y0, x1, y1 = box
                if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
                    raise ValueError('Layout box outside image')
                # Very wide lines are segmented geometrically, never silently
                # truncated or passed to untested oversized NPU graphs.
                span = max(1, int((y1-y0) * 1530 / input_height))
                for left in range(x0, x1, span):
                    lines.append({'bbox': [left, y0, min(x1, left+span), y1]})
            if len(lines) > 4096:
                raise ValueError('Too many text lines')

            async def run():
                async def layout(_page):
                    return lines

                async def prepare(_page, line):
                    if cancelled.is_set():
                        raise InterruptedError()
                    with source.crop(line['bbox']) as crop:
                        target = round(crop.width * input_height / crop.height)
                        bucket = next(w for w in (384, 768, 1536) if target <= w-6)
                        tensor = prepare_line(crop, bucket, input_height)
                    return {'tensor': tensor, 'width': bucket, 'steps': (target+8)//3}

                result = []
                async def commit(_page, recognized):
                    for entry in recognized:
                        x0, y0, x1, y1 = lines[entry['line']]['bbox']
                        result.append({'text': entry['text'],
                            'polygon': [x0,y0,x1,y0,x1,y1,x0,y1]})

                task = asyncio.create_task(run_pipeline(
                    [{'page': 0}], layout, prepare, self.engine, commit, capacity=16))
                async def watch():
                    while not task.done():
                        if cancelled.is_set():
                            task.cancel()
                            return
                        await asyncio.sleep(.05)
                watcher = asyncio.create_task(watch())
                try:
                    metrics = await task
                    return {'text': '\n'.join(l['text'] for l in result), 'lines': result,
                            'engine': 'Tesseract ' + self.variant + ' · NPU (experimental)',
                            'device': 'NPU', 'queue': metrics,
                            'timing': {'inferenceMs':metrics['deviceTotalMs'],
                                'compileMs':sum(c['ms'] for c in self.engine.compilations[compilation_start:]),
                                'serviceMs':(time.perf_counter()-started)*1000}}
                except asyncio.CancelledError as error:
                    raise InterruptedError() from error
                finally:
                    watcher.cancel()
                    await asyncio.gather(watcher, return_exceptions=True)
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            return asyncio.run(run())
        finally:
            raw = None
            if source is not None:
                source.close()
