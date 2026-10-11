"""Offline speech recognition. No Torch, network, or audio history.

Only pinned files from the desktop model library are accepted. The worker owns
one model and one microphone; recording stops before the final inference drains.
"""
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import time
import numpy as np

RATE, FRAME = 16000, 480  # WebRTC VAD: 30 ms, mono PCM16


def model_directory(engine, root, bundled, manifest):
    item = next(m for m in manifest['models'] if m['id'] == engine)
    downloaded = Path(root) / engine / item['revision']
    candidates = []
    try:
        completed = json.loads((downloaded / '.complete.json').read_text('utf-8'))
        if completed['id'] == engine and completed['revision'] == item['revision']:
            candidates.append(downloaded)
    except (OSError, ValueError, KeyError):
        pass
    candidates.append(Path(bundled))
    for base in candidates:
        try:
            for asset in item['files']:
                file = base / asset['path']
                for parent in (file, *file.parents):
                    info = parent.lstat()
                    if parent.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
                        raise ValueError('unsafe')
                if file.stat().st_size != asset['bytes']:
                    raise ValueError('checksum')
                with file.open('rb') as source:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                if digest.hexdigest() != asset['sha256']:
                    raise ValueError('checksum')
            return base / engine
        except (OSError, ValueError):
            continue
    raise ValueError('model-missing')


class Segmenter:
    """Speech-only segments, 300 ms pre-roll, 720 ms tail, bounded at 20 s.

    Calls are frame-aligned. Pause boundaries and forced cuts never overlap. No inference runs for silent frames.
    """
    def __init__(self, is_speech):
        self.is_speech = is_speech
        self.pre = collections.deque(maxlen=10)
        self.votes = collections.deque(maxlen=5)
        self.frames = []
        self.silent = self.voiced = 0

    def push(self, frame):
        speech = self.is_speech(frame, RATE)
        if not self.frames:
            self.pre.append(frame)
            self.votes.append(speech)
            if sum(self.votes) >= 3:
                self.frames = list(self.pre)
                self.voiced = sum(self.votes)
                self.pre.clear()
                self.votes.clear()
            return None
        self.frames.append(frame)
        self.voiced += int(speech)
        self.silent = 0 if speech else self.silent + 1
        if self.silent >= 24 or len(self.frames) >= 666:
            forced = self.silent < 24
            result = self.flush()
            # Pre-roll the cut without recognizing the same words twice. The
            # forced cut keeps no overlap to avoid duplicate dictated text.
            if forced:
                self.votes.clear()
            return result
        return None

    def flush(self):
        result = b''.join(self.frames) if self.voiced >= 5 else None
        self.frames = []
        self.silent = self.voiced = 0
        self.pre.clear()
        self.votes.clear()
        return result


class SpeechModel:
    def __init__(self, engine, directory, device='AUTO', language='zh-CN'):
        self.engine = engine
        self.device = 'CPU'
        self.fallback = ''
        self.lease = None
        self.pipeline = None
        self.cache = None
        self.language = language
        if engine == 'sensevoice-small':
            import sherpa_onnx
            self.pipeline = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(directory / 'model.int8.onnx'),
                tokens=str(directory / 'tokens.txt'), num_threads=2,
                use_itn=True, language='en' if language.startswith('en') else 'zh',
                provider='cpu', debug=False)
        else:
            import openvino as ov
            import openvino_genai as genai
            from cache_lease import acquire_cache_lease
            self.lease = acquire_cache_lease()
            available = ov.Core().available_devices
            choices = ['NPU', 'GPU', 'CPU'] if device == 'AUTO' else [device, 'CPU'] if device != 'CPU' else ['CPU']
            failed = []
            cache = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'SurfaceTab/whisper-openvino-cache' / ov.__version__.split('-')[0]
            cache.mkdir(parents=True, exist_ok=True)
            self.cache = cache
            for target in choices:
                if not any(d == target or d.startswith(target + '.') for d in available):
                    failed.append(target)
                    continue
                try:
                    options = {'CACHE_DIR': str(cache)} if target != 'CPU' else {'INFERENCE_NUM_THREADS': 2, 'NUM_STREAMS': 1}
                    self.pipeline = genai.WhisperPipeline(str(directory), target, **options)
                    self.device = target
                    break
                except Exception:
                    failed.append(target)
            if self.pipeline is None:
                self.close()
                raise RuntimeError('device')
            self.fallback = ', '.join(failed)
            from opus_cache import trim_cache
            trim_cache(cache, budget=768 * 1024 * 1024)

    def transcribe(self, samples, language):
        samples = np.asarray(samples, dtype=np.float32)
        if not len(samples) or len(samples) > RATE * 30 or not np.isfinite(samples).all():
            raise ValueError('audio')
        if self.engine == 'sensevoice-small':
            # SenseVoice's language is a recognizer setting, so the controller
            # recreates this cheap CPU recognizer when language changes.
            stream = self.pipeline.create_stream()
            stream.accept_waveform(RATE, samples)
            self.pipeline.decode_stream(stream)
            text = stream.result.text
        else:
            config = self.pipeline.get_generation_config()
            config.language = '<|en|>' if language.startswith('en') else '<|zh|>'
            config.task = 'transcribe'
            config.max_new_tokens = 256
            config.return_timestamps = False
            text = str(self.pipeline.generate(samples.tolist(), config))
        return re.sub(r'<\|[^|]*\|>', '', text).strip()[:8000]

    def close(self):
        self.pipeline = None
        if self.lease:
            self.lease.close()
            self.lease = None


def read_wav(file):
    import wave
    import soxr
    with wave.open(str(file), 'rb') as audio:
        if audio.getsampwidth() != 2 or audio.getnframes() > audio.getframerate() * 30:
            raise ValueError('audio')
        samples = np.frombuffer(audio.readframes(audio.getnframes()), '<i2').astype(np.float32) / 32768
        samples = samples.reshape(-1, audio.getnchannels()).mean(axis=1)
        rate = audio.getframerate()
    return soxr.resample(samples, rate, RATE) if rate != RATE else samples


def record(stop, emit, session, segments):
    """Capture/VAD thread stays responsive while the inference thread runs."""
    import queue
    import sounddevice as sd
    import soxr
    import webrtcvad
    frames = queue.Queue(maxsize=100)  # at most three seconds of raw input
    overflow = False

    def callback(data, _count, _timing, status):
        nonlocal overflow
        if status.input_overflow:
            overflow = True
        try:
            frames.put_nowait(data[:, 0].copy())
        except queue.Full:
            overflow = True

    segmenter = Segmenter(webrtcvad.Vad(2).is_speech)
    remainder = b''
    last_level = 0.0
    try:
        if stop.is_set():
            return
        # Prefer native 16 kHz; fall back to the microphone's native sample rate.
        try:
            sd.check_input_settings(channels=1, dtype='float32', samplerate=RATE)
            rate = RATE
        except sd.PortAudioError:
            rate = int(sd.query_devices(kind='input')['default_samplerate'])
        resampler = soxr.ResampleStream(rate, RATE, 1, dtype='float32') if rate != RATE else None
        with sd.InputStream(channels=1, samplerate=rate, dtype='float32',
                            blocksize=int(rate * .03), callback=callback) as input_stream:
            emit('ready', session, device=session['device'])
            while not stop.is_set() or not frames.empty():
                if stop.is_set() and input_stream.active:
                    # Close capture first, then drain all audio already received.
                    # Inference load must not discard the last queued frames.
                    input_stream.abort()
                if overflow:
                    raise RuntimeError('overload')
                try:
                    chunk = frames.get(timeout=.05)
                except queue.Empty:
                    continue
                if resampler:
                    chunk = resampler.resample_chunk(chunk)
                if time.monotonic() - last_level >= .1 and len(chunk):
                    rms = float(np.sqrt(np.mean(chunk * chunk)))
                    emit('level', session, level=min(100, round(rms * 500)))
                    last_level = time.monotonic()
                remainder += (np.clip(chunk, -1, 1) * 32767).astype('<i2').tobytes()
                while len(remainder) >= FRAME * 2:
                    frame, remainder = remainder[:FRAME * 2], remainder[FRAME * 2:]
                    segment = segmenter.push(frame)
                    if segment:
                        segments.put_nowait(segment)
        final = segmenter.flush()
        if final:
            segments.put_nowait(final)
    except queue.Full:
        emit('error', session, error='overload')
    except Exception as error:
        emit('error', session, error='overload' if str(error) == 'overload' else 'microphone')
    finally:
        stop.set()
        # Queue is bounded. Wait only for already queued inference to drain.
        segments.put(None)
