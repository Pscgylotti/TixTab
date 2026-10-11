"""Reuse the two pinned Piper voices without downloading or modifying weights."""
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

REVISION = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117'
VOICES = {
    'en_US-lessac-low': ('en/en_US/lessac/low', (
        (63201294, 'f7d01dde371555732c4c314111ac79672b1a5ce2fc19266ab42178fd8df7f375'),
        (4882, '45754dfdebb3b8661c3fc564713772deec6e064feeb5b4e9594857dc7305193a'))),
    'zh_CN-huayan-x_low': ('zh/zh_CN/huayan/x_low', (
        (20628813, 'd30b143fac66d821a1285aa013295adf5cd129d3cc11d70334e51c7b20662c37'),
        (4164, '5521dcb09adf68a9bee289032f7f5af18d29bff020953429b5d223ec1f881816'))),
}


def records(voice):
    if voice not in VOICES:
        raise ValueError('Unsupported Piper voice')
    prefix, hashes = VOICES[voice]
    return [(f'piper/{prefix}/{voice}{suffix}', {'size':size, 'sha256':digest})
            for suffix, (size, digest) in zip(('.onnx', '.onnx.json'), hashes)]


def voice_directory(voice):
    files = records(voice)
    root = Path(__file__).resolve().parent.parent
    configured = os.environ.get('SURFACETAB_PIPER_DIR')
    candidates = [Path(configured)] if configured else [root / 'public/models', root / 'dist/models']
    if not configured:
        managed = managed_directory('piper-zh' if voice.startswith('zh_') else 'piper-en', REVISION)
        if managed:
            candidates.insert(0, managed)
    for candidate in candidates:
        if all((candidate / name).is_file() for name, _ in files):
            if not all(valid_file(candidate / name, record) for name, record in files):
                raise ValueError('Piper model checksum mismatch')
            return candidate / Path(files[0][0]).parent
    if configured:
        raise ValueError('SURFACETAB_PIPER_DIR does not contain the prepared voice')
    return extract_archive(root / 'resources/app.asar', voice)


def extract_archive(archive, voice):
    files = records(voice)
    folder = Path(os.environ.get('LOCALAPPDATA', str(Path(archive).parent))) / 'SurfaceTab/native-models/piper' / REVISION / voice
    with Path(archive).open('rb') as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError('Invalid packaged Piper header')
        _, header_size, _, json_size = struct.unpack('<4I', prefix)
        if not 0 < json_size < header_size <= 8_000_000:
            raise ValueError('Invalid packaged Piper header')
        header = json.loads(stream.read(json_size))
        for name, record in files:
            destination = folder / Path(name).name
            if valid_file(destination, record):
                continue
            entry = header
            for part in ('dist/models/' + name).split('/'):
                entry = entry['files'][part]
            if entry.get('unpacked') or int(entry['size']) != record['size'] or int(entry['offset']) < 0:
                raise ValueError('Invalid packaged Piper entry')
            stream.seek(8 + header_size + int(entry['offset']))
            data = stream.read(record['size'])
            if len(data) != record['size'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Packaged Piper checksum mismatch')
            folder.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(destination)
    return folder
