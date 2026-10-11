"""Shared native-cache residency lease; no polling and no model imports.

On Windows, a normal CRT read/write handle permits other readers but prevents
the cache cleaner from opening the same file with FileShare.None. The cleaner
also prevents new model constructors until it closes that exclusive handle.
"""
from pathlib import Path
import functools
import os
import weakref


class CacheBusyError(RuntimeError):
    pass


def acquire_cache_lease():
    root = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'SurfaceTab'
    path = root / 'native-cache-use.lock'
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
            if entry.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise CacheBusyError('Native cache path contains a link')
        except FileNotFoundError:
            pass
    root.mkdir(parents=True, exist_ok=True)
    lease = None
    try:
        lease = path.open('a+b')
        if os.name != 'nt':
            import fcntl
            fcntl.flock(lease, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return lease
    except OSError as error:
        if lease is not None:
            lease.close()
        raise CacheBusyError('Native cache maintenance is running') from error


def cache_user(cls):
    original = cls.__init__

    @functools.wraps(original)
    def initialize(self, *args, **kwargs):
        lease = acquire_cache_lease()
        try:
            original(self, *args, **kwargs)
        except BaseException:
            lease.close()
            raise
        weakref.finalize(self, lease.close)

    cls.__init__ = initialize
    return cls
