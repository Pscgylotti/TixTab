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
import multiprocessing
import os
from pathlib import Path
import platform
import re
import sys
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


def collect_process(connection, process_id, origin):
    """Sample out of process: native compilation can hold the parent's GIL."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    memory_api = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
    memory_api.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemory), wintypes.DWORD]
    memory_api.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessIo)]
    kernel.GetProcessIoCounters.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x400 | 0x10, False, process_id)
    samples = []
    phase = 'setup'

    def snapshot():
        start = time.perf_counter()
        memory = ProcessMemory()
        memory.cb = ctypes.sizeof(memory)
        io = ProcessIo()
        if not memory_api(handle, ctypes.byref(memory), memory.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GetProcessIoCounters(handle, ctypes.byref(io)):
            raise ctypes.WinError(ctypes.get_last_error())
        created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(system), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        seconds = sum((value.dwHighDateTime << 32) | value.dwLowDateTime for value in (system, user)) / 10_000_000
        result = {'at': (start - origin) * 1000, 'phase': phase,
                  'processes': [{'pid': process_id, 'type': 'ASR',
                                 'cpu': {'cumulativeCPUUsage': seconds},
                                 'workingSetBytes': memory.workingSetBytes,
                                 'peakWorkingSetBytes': memory.peakWorkingSetBytes,
                                 'privateBytes': memory.privateBytes,
                                 'io': {key: getattr(io, key) for key, _ in ProcessIo._fields_}}],
                  'collectMs': (time.perf_counter() - start) * 1000}
        samples.append(result)
        return result

    try:
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        connection.send({'ready': True, 'sample': snapshot()})
        deadline = time.perf_counter() + .2
        while True:
            if connection.poll(max(0, deadline - time.perf_counter())):
                command = connection.recv()
                phase = command.get('phase', phase)
                if command['action'] == 'finish':
                    snapshot()
                    connection.send({'samples': samples, 'collectorCpuSeconds': time.process_time()})
                    break
                if command['action'] == 'capture':
                    connection.send({'sample': snapshot()})
            if time.perf_counter() >= deadline:
                snapshot()
                deadline = time.perf_counter() + .2
    except BaseException as error:
        connection.send({'error': repr(error)})
    finally:
        if handle:
            kernel.CloseHandle(handle)
        connection.close()


class Collector:
    def __init__(self):
        self.origin = time.perf_counter()
        self.phase = 'setup'
        self.samples = []
        self.collector_cpu = None
        context = multiprocessing.get_context('spawn')
        self.connection, child = context.Pipe()
        self.worker = context.Process(target=collect_process, args=(child, os.getpid(), self.origin), daemon=True)
        self.child_connection = child

    def receive(self):
        if not self.connection.poll(30):
            raise TimeoutError('External process collector did not respond.')
        response = self.connection.recv()
        if response.get('error'):
            raise RuntimeError('Collector failed: ' + response['error'])
        return response

    def capture(self):
        self.connection.send({'action': 'capture', 'phase': self.phase})
        value = self.receive()['sample']
        return value

    def start(self):
        self.worker.start()
        self.child_connection.close()
        assert self.receive()['ready']

    def finish(self):
        try:
            self.connection.send({'action': 'finish', 'phase': self.phase})
            value = self.receive()
            self.samples = value['samples']
            self.collector_cpu = value['collectorCpuSeconds']
        finally:
            self.connection.close()
            self.worker.join(timeout=5)
            if self.worker.is_alive():
                self.worker.terminate()
                self.worker.join()


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
    try:
        cache_root.relative_to((ROOT / '.cache').resolve())
    except ValueError:
        parser.error('Experiment compilation caches must stay in this workspace .cache directory.')
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
    source_files = ['scripts/benchmark-asr.py', 'backend/native_asr.py',
                    'backend/opus_cache.py', 'backend/cache_lease.py', 'backend/asr-manifest.json']
    source_hashes = {file: digest(ROOT / file) for file in source_files}
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
    if source_hashes != {file: digest(ROOT / file) for file in source_files}:
        raise RuntimeError('Benchmark/backend source changed during measurement; discard the run.')
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
        'sources': source_hashes,
        'collector': {'type': 'independent-process', 'intervalTargetMs': 200,
                      'cpuSeconds': collector.collector_cpu,
                      'maximumGapMs': max(b['at'] - a['at'] for a, b in zip(collector.samples, collector.samples[1:]))},
        'limitations': [
            'CPU/memory/I/O belong to the inference Python process and its threads; collector CPU is reported separately. Driver/service processes and GPU/NPU hardware activity are unmeasured.',
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
