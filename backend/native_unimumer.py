"""Optional pinned Uni-MuMER Qwen3-VL-2B GGUF; isolated llama.cpp Vulkan worker.

No downloads at inference time. Use the desktop model library for both assets.
GPU/CPU only; NPU is not advertised for this backend.
"""
from pathlib import Path
import base64
import binascii
import hashlib
import io
import json
import math
import os
import queue
import re
import secrets
import socket
import subprocess
import threading
import time
import tempfile
import urllib.error
import urllib.request
import zipfile
from PIL import Image, UnidentifiedImageError
try:
    from .managed_store import managed_directory
    from .cache_lease import cache_user
except ImportError:
    from managed_store import managed_directory
    from cache_lease import cache_user

MANIFEST = json.loads(Path(__file__).with_name('unimumer-manifest.json').read_text('utf-8'))
_verified = {}


def verify(path, record):
    info = path.stat()
    identity = (str(path.resolve()), info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                info.st_ino, record['sha256'])
    if info.st_size != record['bytes']:
        raise ValueError('Uni-MuMER file size mismatch')
    # Tiny files cost little to hash, and rapid replacement on Windows can
    # share a timestamp. Only memoize immutable, large model/runtime assets.
    if info.st_size < 1_000_000 or identity not in _verified:
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        digest = digest.hexdigest()
        if digest != record['sha256']:
            raise ValueError('Uni-MuMER file checksum mismatch')
        if info.st_size >= 1_000_000:
            if len(_verified) >= 256:
                _verified.pop(next(iter(_verified)))
            _verified[identity] = True


def assets(which, manifest=MANIFEST):
    record = manifest[which]
    base = managed_directory(record['id'], record['revision'])
    if base is None:
        raise ValueError('Download Uni-MuMER model and runtime in Local model manager first')
    paths = []
    for item in record['files']:
        path = base / item['path']
        verify(path, item)
        paths.append(path)
    return paths


def runtime(record=None):
    record = record or MANIFEST['runtime']
    archive = assets('runtime', {'runtime': record})[0]
    root = Path(os.environ.get('SURFACETAB_UNIMUMER_RUNTIME', str(Path.home() / '.surfacetab/unimumer-runtime')))
    if record['id'] != 'unimumer-runtime':
        root = Path.home() / '.surfacetab' / record['id']
    target = root / record['revision']
    for entry in (target, *target.parents):
        if entry.is_symlink() or (entry.exists() and getattr(entry.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('Runtime directory contains a link')
    marker = target / '.complete.json'
    if marker.exists():
        manifest = json.loads(marker.read_text('utf-8'))
        if manifest.get('archive') == record['files'][0]['sha256']:
            for member in manifest['files']:
                verify(target / member['path'], member)
            return target / manifest['executable']
    target.mkdir(parents=True, exist_ok=True)
    records, executable = [], None
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            if item.is_dir():
                continue
            name = Path(item.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in item.filename or item.file_size > 200_000_000:
                raise ValueError('Invalid pinned runtime archive')
            output = target / name
            output.parent.mkdir(parents=True, exist_ok=True)
            data = source.read(item)
            output.write_bytes(data)
            records.append({'path': item.filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            if name.name == 'llama-server.exe':
                executable = item.filename
    if not executable:
        raise ValueError('Pinned runtime has no llama-server executable')
    marker.write_text(json.dumps({'archive': record['files'][0]['sha256'], 'files': records, 'executable': executable}), encoding='utf-8')
    return target / executable


class WindowsJob:
    """Own child processes die even if the parent Python service is terminated."""
    def __init__(self, process):
        self.handle = None
        if os.name != 'nt':
            return
        import ctypes
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('user', ctypes.c_int64), ('job', ctypes.c_int64), ('flags', w.DWORD), ('min', ctypes.c_size_t), ('max', ctypes.c_size_t), ('processes', w.DWORD), ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Limits(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', ctypes.c_uint64 * 6), ('processMemory', ctypes.c_size_t), ('jobMemory', ctypes.c_size_t), ('peakProcess', ctypes.c_size_t), ('peakJob', ctypes.c_size_t)]
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.CreateJobObjectW.restype = w.HANDLE
        api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        api.CloseHandle.argtypes = [w.HANDLE]
        handle = api.CreateJobObjectW(None, None)
        limits = Limits(); limits.basic.flags = 0x2000
        if not handle or not api.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not api.AssignProcessToJobObject(handle, w.HANDLE(int(process._handle))):
            if handle: api.CloseHandle(handle)
            process.terminate()
            raise RuntimeError('Cannot isolate the local model process')
        self.handle, self.api = handle, api

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


@cache_user
class NativeUnimumer:
    engine_label = 'Uni-MuMER'
    def __init__(self):
        self.files = self.model_files()
        self.executable = self.runtime_executable()
        self.process = None
        self.job = None
        self.log = None
        self.encoder_device = None
        self.requested_device = None
        self.key = secrets.token_urlsafe(32)
        self.logfile = None
        self.gpu_unavailable = False

    def runtime_executable(self):
        return runtime()

    def process_environment(self, requested):
        return None

    def resolve_device(self, device):
        return 'CPU' if device == 'CPU' or device == 'AUTO' and self.gpu_unavailable else 'GPU'

    def actual_device(self, requested, log):
        return 'GPU' if requested == 'GPU' and re.search(r'offloaded [1-9]\d*/\d+ layers|offloaded [1-9]\d* layers', log) else 'CPU'

    def model_files(self):
        return assets('model')

    def server_arguments(self, requested):
        args = [str(self.executable), '-m', str(self.files[0]), '--mmproj', str(self.files[1]), '--host', '127.0.0.1', '--port', str(self.port), '--api-key', self.key, '--alias', 'unimumer-qwen3-vl-2b', '-c', '4096', '-np', '1', '-t', '2', '-tb', '4', '-ngl', '0' if requested == 'CPU' else '99', '-b', '512', '-ub', '128', '--no-webui']
        args += ['-lv', '4', '--image-max-tokens', '256']
        if requested == 'CPU': args.append('--no-mmproj-offload')
        else: args += ['--device', 'Vulkan0']
        return args

    def close(self):
        if self.job: self.job.close(); self.job = None
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try: self.process.wait(timeout=2)
                except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=2)
            self.process = None
        if self.log: self.log.close(); self.log = None
        if self.logfile:
            try: self.logfile.unlink(missing_ok=True)
            except OSError: pass  # Windows may briefly retain the terminated child's log handle.
            self.logfile = None

    def __del__(self):
        try: self.close()
        except Exception: pass

    def request(self, route, body=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{route}', data=data, headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=180 if body else 1) as response:
            return json.load(response)

    def start(self, device, cancelled):
        if cancelled.is_set(): raise InterruptedError()
        requested = self.resolve_device(device)
        if self.process and self.process.poll() is None and self.requested_device == requested:
            return
        self.close()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        fd, name = tempfile.mkstemp(prefix='surfacetab-unimumer-', suffix='.log')
        logfile = self.logfile = Path(name)
        self.log = os.fdopen(fd, 'wb')
        args = self.server_arguments(requested)
        self.process = subprocess.Popen(args, cwd=self.executable.parent, stdout=self.log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), env=self.process_environment(requested))
        self.job = WindowsJob(self.process)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if cancelled.is_set(): self.close(); raise InterruptedError()
            if self.process.poll() is not None:
                exit_code = self.process.returncode
                self.close()
                if device == 'AUTO':
                    self.gpu_unavailable = True
                    return self.start('CPU', cancelled)
                raise RuntimeError(f'Local {self.engine_label} engine exited ({exit_code}); check model/runtime/driver compatibility')
            try:
                if self.request('/health').get('status') == 'ok':
                    log = logfile.read_text('utf-8', errors='replace')
                    self.encoder_device = self.actual_device(requested, log)
                    self.requested_device = requested
                    return
            except (OSError, ValueError, urllib.error.URLError): pass
            cancelled.wait(.2)
        self.close(); raise TimeoutError(f'{self.engine_label} startup timed out')

    def recognize(self, image, device='AUTO', cancelled=None):
        cancelled = cancelled or threading.Event()
        if device not in ['AUTO', 'GPU', 'CPU']: raise ValueError('Uni-MuMER supports GPU and CPU only')
        start = time.perf_counter()
        try:
            if not isinstance(image, str) or not image.startswith('data:image/png;base64,') or len(image) > 4_000_000:
                raise ValueError('Only PNG images up to 4 MB are accepted')
            data = base64.b64decode(image.split(',', 1)[1], validate=True)
            if len(data) > 3_000_000: raise ValueError('Image exceeds limit')
            with Image.open(io.BytesIO(data)) as source:
                if source.format != 'PNG': raise ValueError('Only PNG images are accepted')
                if source.width * source.height > 8_000_000: raise ValueError('Image exceeds pixel limit')
                source.load(); rgb = Image.new('RGB', source.size, 'white')
                if source.mode == 'RGBA': rgb.paste(source, mask=source.getchannel('A'))
                else: rgb.paste(source.convert('RGB'))
            factor = min(1, math.sqrt(262144 / (rgb.width * rgb.height)), 1024 / max(rgb.size))
            if factor < 1: rgb = rgb.resize((max(1, round(rgb.width * factor)), max(1, round(rgb.height * factor))), Image.Resampling.LANCZOS)
            buffer = io.BytesIO(); rgb.save(buffer, format='PNG')
        except (IndexError, OSError, UnidentifiedImageError, binascii.Error) as error:
            raise ValueError('Invalid formula image') from error
        self.start(device, cancelled)
        payload = {'model': 'unimumer-qwen3-vl-2b', 'messages': [{'role': 'system', 'content': 'You are a helpful assistant.'}, {'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()}}, {'type': 'text', 'text': 'I have an image of a handwritten mathematical expression. Please write out the expression of the formula in the image using LaTeX format.'}]}], 'temperature': 0, 'max_tokens': 1024, 'stream': False}
        responses = queue.Queue()
        def work():
            try: responses.put((True, self.request('/v1/chat/completions', payload)))
            except Exception as error: responses.put((False, error))
        thread = threading.Thread(target=work, daemon=True); thread.start()
        deadline = time.monotonic() + 180
        while True:
            if cancelled.is_set(): self.close(); thread.join(timeout=2); raise InterruptedError()
            if time.monotonic() > deadline: self.close(); thread.join(timeout=2); raise TimeoutError('Uni-MuMER inference timed out')
            try: ok, value = responses.get(timeout=.1); break
            except queue.Empty: pass
        if not ok: raise RuntimeError('Uni-MuMER local inference failed') from value
        choice = value.get('choices', [{}])[0]
        text = choice.get('message', {}).get('content', '')
        if choice.get('finish_reason') not in ['stop', 'end_turn'] or not isinstance(text, str) or not text.strip():
            raise ValueError('Incomplete formula; select a smaller region')
        text = re.sub(r'^\s*```(?:latex|tex)?\s*\n?|\n?```\s*$', '', text, flags=re.I).strip()
        return {'latex': text, 'encoderDevice': self.encoder_device, 'decoderDevice': self.encoder_device, 'requestedDevice': device, 'fallback': device != 'CPU' and self.encoder_device != 'GPU', 'engine': 'Uni-MuMER Qwen3-VL-2B Q4_K_M', 'timing': {'totalMs': (time.perf_counter() - start) * 1000}, 'tokens': value.get('usage', {}).get('completion_tokens')}
