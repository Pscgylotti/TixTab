"""Verified OPUS weights, reused from development resources or a portable ASAR."""
from pathlib import Path
import hashlib
import json
import os
import struct
try:
    from .managed_store import managed_directory
except ImportError:
    from managed_store import managed_directory

FILES = ('config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx',
         'onnx/decoder_model_merged_quantized.onnx')


def valid_file(path, record):
    if not path.is_file() or path.stat().st_size != record['size']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest() == record['sha256']


def verify_files(folder, direction):
    manifest = json.loads((folder / 'manifest.json').read_text('utf-8'))
    if manifest.get('name') != 'opus-' + direction:
        raise ValueError('OPUS model direction mismatch')
    for name in FILES:
        record = next((r for r in manifest['files'] if r.get('file') == name), None)
        if not record or not valid_file(folder / name, record):
            raise ValueError('OPUS model checksum mismatch: ' + name)
    return manifest


def model_directory(direction):
    if direction not in ('en-zh', 'zh-en'):
        raise ValueError('Unsupported translation direction')
    root = Path(__file__).resolve().parent.parent
    name = 'opus-' + direction
    configured = os.environ.get('SURFACETAB_OPUS_DIR')
    candidates = [Path(configured) / name] if configured else [root / 'public/models' / name, root / 'dist/models' / name]
    if not configured:
        revision = '046f55aec303cdee3e0318604406d4df20f1e8ea' if direction == 'en-zh' else '39d480d52a9ea3065a1f117adfe4dbc55de10e6f'
        managed = managed_directory(name, revision, name)
        if managed:
            candidates.insert(0, managed)
    for folder in candidates:
        if all((folder / file).is_file() for file in FILES):
            verify_files(folder, direction)
            return folder
    if configured:
        raise ValueError('SURFACETAB_OPUS_DIR does not contain prepared OPUS weights')
    return extract_archive(root / 'resources/app.asar', direction)


def extract_archive(archive, direction):
    """Only four fixed, checksummed files; no arbitrary archive paths or downloads."""
    name = 'opus-' + direction
    with Path(archive).open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError('Invalid packaged model header')
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size < header_size <= 8_000_000:
            raise ValueError('Invalid packaged model header')
        header = json.loads(stream.read(json_size))

        def read(file):
            entry = header
            for part in ('dist/models/' + name + '/' + file).split('/'):
                entry = entry['files'][part]
            size = int(entry['size'])
            if not 0 < size <= 128_000_000 or entry.get('unpacked') or int(entry['offset']) < 0:
                raise ValueError('Invalid packaged model entry')
            stream.seek(8 + header_size + int(entry['offset']))
            data = stream.read(size)
            if len(data) != size:
                raise ValueError('Incomplete packaged model')
            return data

        manifest_data = read('manifest.json')
        manifest = json.loads(manifest_data)
        revision = manifest.get('revision')
        if manifest.get('name') != name or not isinstance(revision, str) or not revision.isalnum():
            raise ValueError('Invalid OPUS model manifest')
        cache_root = Path(os.environ.get('LOCALAPPDATA', str(Path(archive).parent))) / 'SurfaceTab/native-models'
        folder = cache_root / name / revision
        for file in FILES:
            record = next((r for r in manifest['files'] if r.get('file') == file), None)
            destination = folder / file
            if not record:
                raise ValueError('Missing OPUS model checksum: ' + file)
            if valid_file(destination, record):
                continue
            data = read(file)
            if len(data) != record['size'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Packaged model checksum mismatch: ' + file)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(destination)
        # Each reused file was hashed above; each replacement was checked before
        # its atomic write. Avoid hashing another ~120 MB on every model switch.
        manifest_temporary = folder / 'manifest.json.tmp'
        manifest_temporary.write_bytes(manifest_data)
        manifest_temporary.replace(folder / 'manifest.json')
        return folder
