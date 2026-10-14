"""Fixed-input ASR resource experiment; no microphone, network or user-cache writes.

Run with the existing ASR runtime's Python. Each process measures imports, pinned
weight verification, model construction, repeated transcription, resident idle,
explicit release and released idle. Cache metadata is evidence of file reuse,
not proof that every internal driver graph was loaded without compilation.
"""
import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as source:
        result = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
        return result.hexdigest()


class ProcessMemory(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('pageFaultCount', wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            'peakWorkingSetBytes', 'workingSetBytes', 'quotaPeakPagedPoolBytes',
            'quotaPagedPoolBytes', 'quotaPeakNonPagedPoolBytes', 'quotaNonPagedPoolBytes',
            'pagefileBytes', 'peakPagefileBytes', 'privateBytes')]


class ProcessIo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        'readOperations', 'writeOperations', 'otherOperations',
        'readTransferBytes', 'writeTransferBytes', 'otherTransferBytes')]


class Collector:
    def __init__(self):
        self.origin = time.perf_counter()
        self.phase = 'setup'
        self.samples = []
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.memory_api = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
        self.memory_api.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemory), wintypes.DWORD]
        self.memory_api.restype = wintypes.BOOL
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessIo)]
        self.kernel.GetProcessIoCounters.restype = wintypes.BOOL
        self.handle = self.kernel.GetCurrentProcess()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def snapshot(self):
        start = time.perf_counter()
        memory = ProcessMemory()
        memory.cb = ctypes.sizeof(memory)
        io = ProcessIo()
        if not self.memory_api(self.handle, ctypes.byref(memory), memory.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.kernel.GetProcessIoCounters(self.handle, ctypes.byref(io)):
            raise ctypes.WinError(ctypes.get_last_error())
        result = {'at': (start - self.origin) * 1000, 'phase': self.phase,
                  'processes': [{'pid': os.getpid(), 'type': 'ASR',
                                 'cpu': {'cumulativeCPUUsage': time.process_time()},
                                 'workingSetBytes': memory.workingSetBytes,
                                 'peakWorkingSetBytes': memory.peakWorkingSetBytes,
                                 'privateBytes': memory.privateBytes,
                                 'io': {key: getattr(io, key) for key, _ in ProcessIo._fields_}}],
                  'collectMs': (time.perf_counter() - start) * 1000}
        return result

    def capture(self):
        with self.lock:
            value = self.snapshot()
            self.samples.append(value)
        return value

    def run(self):
        try:
            while not self.stop.wait(.2):
                self.capture()
        except BaseException as error:
            self.error = repr(error)

    def start(self):
        self.error = None
        self.capture()
        self.thread.start()

    def finish(self):
        self.stop.set()
        self.thread.join()
        self.capture()
        if self.error:
            raise RuntimeError('Collector failed: ' + self.error)


def cache_files(root):
    files = []
    if root.exists():
        for path in sorted(root.rglob('*')):
            if path.is_file() and path.suffix in ('.blob', '.cl_cache'):
                stat = path.stat()
                files.append({'file': path.relative_to(root).as_posix(),
                              'bytes': stat.st_size, 'mtimeNs': stat.st_mtime_ns})
    return files


def normalized(text):
    # Only canonicalize punctuation/case and the two numbers in our own fixture.
    text = re.sub(r'\bnine\b', '9', text.lower())
    text = re.sub(r'\bfive\b', '5', text).replace('九', '9').replace('五', '5')
    return ''.join(char for char in text if char.isalnum())


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for row, left in enumerate(a, 1):
        current = [row]
        for col, right in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[col] + 1,
                               previous[col - 1] + int(left != right)))
        previous = current
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['sensevoice-small', 'whisper-small'], required=True)
    parser.add_argument('--device', choices=['AUTO', 'CPU', 'GPU', 'NPU'], default='AUTO')
    parser.add_argument('--language', choices=['en-US', 'zh-CN'], default='en-US')
    parser.add_argument('--mode', choices=['cold', 'cached'], required=True)
    parser.add_argument('--cache-root', type=Path, required=True)
    parser.add_argument('--samples', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--models-root', type=Path, default=Path(os.environ['APPDATA']) / 'surfacetab/model-library/v1')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--idle-seconds', type=float, default=5)
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('This collector uses Windows process CPU/memory/I/O counters.')
    if not 1 <= args.repeats <= 10 or not 1 <= args.idle_seconds <= 60:
        parser.error('Repeats 1..10 and idle seconds 1..60 are supported.')
    if args.engine == 'sensevoice-small' and args.device not in ['CPU', 'AUTO']:
        parser.error('SenseVoiceSmall supports only CPU in this application.')
    cache_root = args.cache_root.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    if cache_root == Path(os.environ.get('LOCALAPPDATA', '')).resolve():
        parser.error('Choose an isolated experiment cache, never the user LOCALAPPDATA directory.')
    cache_before = cache_files(cache_root)
    if args.mode == 'cold' and cache_before:
        parser.error('Cold mode requires an empty experiment compilation cache; nothing is deleted.')
    if args.mode == 'cached' and args.engine == 'whisper-small' and args.device != 'CPU' and not cache_before:
        parser.error('Cached GPU/NPU mode requires previously created compilation files.')
    if args.output.exists():
        parser.error('Reports are never overwritten; choose a new output path.')
    # Backend cache leases and compilation files both stay inside this directory.
    os.environ['LOCALAPPDATA'] = str(cache_root)
    fixture = json.loads((args.samples / 'samples.json').read_text('utf-8-sig'))
    for item in fixture['samples']:
        if digest(args.samples / item['file']) != item['sha256']:
            raise ValueError('Fixture changed: ' + item['file'])
    collector = Collector()
    phases, transcriptions = [], []
    model = None
    collector.start()

    @contextmanager
    def phase(name):
        collector.phase = name
        before = collector.capture()
        print(json.dumps({'event': 'start', 'phase': name}), flush=True)
        try:
            yield
        finally:
            after = collector.capture()
            first, last = before['processes'][0], after['processes'][0]
            phases.append({'name': name, 'startMs': before['at'], 'endMs': after['at'],
                           'wallMs': after['at'] - before['at'],
                           'cpuSeconds': last['cpu']['cumulativeCPUUsage'] - first['cpu']['cumulativeCPUUsage'],
                           'workingSetBytesBefore': first['workingSetBytes'],
                           'workingSetBytesAfter': last['workingSetBytes'],
                           'privateBytesBefore': first['privateBytes'], 'privateBytesAfter': last['privateBytes'],
                           'ioDelta': {key: last['io'][key] - first['io'][key] for key in first['io']}})
            print(json.dumps({'event': 'done', **phases[-1]}), flush=True)

    try:
        with phase('import-runtime'):
            sys.path.insert(0, str(ROOT / 'backend'))
            from native_asr import SpeechModel, model_directory, read_wav
            manifest = json.loads((ROOT / 'backend/asr-manifest.json').read_text('utf-8'))
        with phase('verify-model'):
            directory = model_directory(args.engine, args.models_root, ROOT / 'public/models', manifest)
        with phase('prepare-audio'):
            inputs = {item['language']: (item, read_wav(args.samples / item['file'])) for item in fixture['samples']}
        with phase('load-model'):
            model = SpeechModel(args.engine, directory, args.device, args.language)
        actual, fallback = model.device, model.fallback
        cache_loaded = cache_files(cache_root)
        languages = ['en-US', 'zh-CN'] if args.engine == 'whisper-small' else [args.language]
        for repeat in range(args.repeats):
            for language in languages:
                item, samples = inputs[language]
                with phase(f'transcribe/{language}/{repeat}'):
                    text = model.transcribe(samples, language)
                if not text:
                    raise AssertionError('Empty transcription')
                expected, received = normalized(item['text']), normalized(text)
                transcriptions.append({'language': language, 'repeat': repeat,
                                       'text': text, 'reference': item['text'],
                                       'audioSeconds': len(samples) / 16000,
                                       'normalizedCharacterErrors': edit_distance(expected, received),
                                       'normalizedReferenceCharacters': len(expected)})
        cache_after_inference = cache_files(cache_root)
        with phase('idle-resident'):
            time.sleep(args.idle_seconds)
        with phase('release-model'):
            model.close()
            model = None
        with phase('idle-released'):
            time.sleep(args.idle_seconds)
    finally:
        if model is not None:
            model.close()
        collector.finish()
    report = {
        'schema': 1, 'kind': 'asr-resource-benchmark', 'engine': args.engine,
        'requestedDevice': args.device, 'actualDevice': actual, 'fallback': fallback, 'mode': args.mode,
        'host': {'platform': platform.platform(), 'logicalProcessors': os.cpu_count(),
                 'processor': os.environ.get('PROCESSOR_IDENTIFIER'), 'python': sys.version},
        'runtimeVersions': {package: importlib.metadata.version(package) for package in
                            ['numpy', 'openvino', 'openvino-genai', 'sherpa-onnx']},
        'model': next(item for item in manifest['models'] if item['id'] == args.engine),
        'fixture': fixture, 'phases': phases, 'samples': collector.samples,
        'transcriptions': transcriptions,
        'cache': {'before': cache_before, 'afterLoad': cache_loaded,
                  'afterInference': cache_after_inference, 'afterRelease': cache_files(cache_root),
                  'unchangedDuringInference': cache_loaded == cache_after_inference},
        'sources': {file: digest(ROOT / file) for file in ['scripts/benchmark-asr.py', 'backend/native_asr.py',
                   'backend/opus_cache.py', 'backend/cache_lease.py', 'backend/asr-manifest.json']},
        'limitations': [
            'CPU/memory/I/O belong to this Python process, including its inference threads and collector; driver/service processes and GPU/NPU hardware activity are unmeasured.',
            'I/O transfer counters are process logical transfers, not physical disk traffic or energy. Working set includes shared pages; sampled peaks can miss short spikes.',
            'Sampling targets 200 ms but uses actual timestamps. No 50 ms spike claim. Interpreter bootstrap and fixture-hash preparation precede collection; report serialization is outside the window.',
            'Cold means empty compilation files, not cold OS file cache. Cached means a fresh Python/model instance with previous compilation files, not resident-model reuse.',
            'No compiler hit telemetry is exposed by this pipeline; unchanged files do not prove that every internal graph skipped compilation.',
            'Two clean system-TTS sentences are a smoke/latency fixture, not an accuracy benchmark or real microphone test.',
            'No watts, joules, battery-life or low-power-device conclusion; default production idle policy remains 1800 seconds. Explicit release is measured separately from natural idle expiry.',
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'event': 'saved', 'output': str(args.output), 'actualDevice': actual,
                      'transcriptions': len(transcriptions), 'samples': len(collector.samples)}), flush=True)


if __name__ == '__main__':
    main()
