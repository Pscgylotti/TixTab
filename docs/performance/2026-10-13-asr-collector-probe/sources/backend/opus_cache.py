"""Bounded, optional disk cache for this experimental graph revision only."""
from pathlib import Path
import os
import re
import stat

CACHE_BUDGET = 768 * 1024 * 1024
GRAPH_REVISION = 'continuous-encoder-bounded-decoder-v1'


def cache_directory(version):
    base = os.environ.get('SURFACETAB_OPUS_CACHE')
    if base:
        root = Path(base)
    else:
        root = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'SurfaceTab/opus-openvino-cache'
    directory = root / GRAPH_REVISION / re.sub(r'[^a-zA-Z0-9._-]', '_', version)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def trim_cache(directory, budget=CACHE_BUDGET):
    """Delete oldest own cache files. Never follow links or touch model weights."""
    files = []
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file():
            continue
        try:
            metadata = path.stat()
            files.append((metadata.st_mtime, metadata.st_size, path))
        except OSError:
            pass
    total = sum(size for _, size, _ in files)
    for _, size, path in sorted(files):
        if total <= budget:
            break
        try:
            # OpenVINO marks cache blobs read-only on Windows.
            if not path.stat().st_mode & stat.S_IWRITE:
                path.chmod(stat.S_IREAD | stat.S_IWRITE)
            path.unlink()
            total -= size
        except OSError:
            # Drivers may still hold a compiled blob open on Windows.
            pass
    return total
