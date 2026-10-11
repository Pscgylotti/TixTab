"""Fixed, checksummed PP-OCRv4 assets; no network access at inference time."""
from pathlib import Path
import hashlib
import json
import os
import struct
try:
    from .managed_store import managed_directory
except ImportError:
    from managed_store import managed_directory
try:
    from .opus_store import valid_file
except ImportError:
    from opus_store import valid_file

FILES = ('ch_PP-OCRv4_det_mobile.onnx', 'ch_PP-OCRv4_rec_mobile.onnx',
         'ch_ppocr_mobile_v2.0_cls_mobile.onnx')
HASHES = ('d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
          '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
          'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c')


def records(manifest):
    if manifest.get('name') != 'ppocrv4' or manifest.get('revision') != 'rapidocr310':
        raise ValueError('Invalid OCR model manifest')
    result = []
    for name, sha in zip(FILES, HASHES):
        record = next((r for r in manifest.get('files', []) if r.get('file') == name), None)
        if not record or record.get('sha256') != sha or not 0 < record.get('size', 0) < 16_000_000:
            raise ValueError('Invalid OCR model record: ' + name)
        result.append(record)
    return result


def model_directory():
    root = Path(__file__).resolve().parent.parent
    configured = os.environ.get('SURFACETAB_OCR_DIR')
    candidates = [Path(configured)] if configured else [root / 'public/models/ppocrv4', root / 'dist/models/ppocrv4']
    if not configured:
        managed = managed_directory('ppocrv4', 'rapidocr310', 'ppocrv4')
        if managed:
            candidates.insert(0, managed)
    for folder in candidates:
        if all((folder / name).is_file() for name in FILES):
            for record in records(json.loads((folder / 'manifest.json').read_text('utf-8'))):
                if not valid_file(folder / record['file'], record):
                    raise ValueError('OCR model checksum mismatch: ' + record['file'])
            return folder
    if configured:
        raise ValueError('SURFACETAB_OCR_DIR does not contain prepared OCR weights')
    return extract_archive(root / 'resources/app.asar')


def extract_archive(archive):
    with Path(archive).open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError('Invalid packaged model header')
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size < header_size <= 8_000_000:
            raise ValueError('Invalid packaged model header')
        header = json.loads(stream.read(json_size))

        def read(name):
            entry = header
            for part in ('dist/models/ppocrv4/' + name).split('/'):
                entry = entry['files'][part]
            size, offset = int(entry['size']), int(entry['offset'])
            if not 0 < size < 16_000_000 or offset < 0 or entry.get('unpacked'):
                raise ValueError('Invalid packaged OCR entry')
            stream.seek(8 + header_size + offset)
            data = stream.read(size)
            if len(data) != size:
                raise ValueError('Incomplete packaged OCR model')
            return data

        manifest_data = read('manifest.json')
        manifest = json.loads(manifest_data)
        folder = Path(os.environ.get('LOCALAPPDATA', str(Path(archive).parent))) / 'SurfaceTab/native-models/ppocrv4/rapidocr310'
        for record in records(manifest):
            destination = folder / record['file']
            if valid_file(destination, record):
                continue
            data = read(record['file'])
            if len(data) != record['size'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Packaged OCR checksum mismatch')
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix('.tmp')
            temporary.write_bytes(data)
            temporary.replace(destination)
        temporary = folder / 'manifest.json.tmp'
        temporary.write_bytes(manifest_data)
        temporary.replace(folder / 'manifest.json')
        return folder
