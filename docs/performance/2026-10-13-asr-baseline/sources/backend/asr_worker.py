"""Owned stdin/stdout worker. Configurable model idle deadline; audio never leaves memory."""
import argparse
import json
import queue
import sys
import threading
import time
from pathlib import Path
from native_asr import SpeechModel, model_directory, read_wav
from asr_lifecycle import Session, SessionLifecycle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models-root', required=True)
    parser.add_argument('--bundled', required=True)
    parser.add_argument('--manifest', default=str(Path(__file__).with_name('asr-manifest.json')))
    parser.add_argument('--engine', choices=['sensevoice-small', 'whisper-small'], required=True)
    parser.add_argument('--device', choices=['AUTO', 'NPU', 'GPU', 'CPU'], default='AUTO')
    parser.add_argument('--language', default='zh-CN')
    parser.add_argument('--idle-seconds', type=int, default=1800)
    parser.add_argument('--wav')  # deterministic verification, never exposed via renderer IPC
    parser.add_argument('--capture-wav')  # test input in place of the microphone
    args = parser.parse_args()
    idle_seconds = min(86400, max(30, args.idle_seconds))
    write_lock = threading.Lock()

    def emit(event, session=None, **values):
        with write_lock:
            print(json.dumps({'event': event, 'id': session['id'] if session else '', **values}, ensure_ascii=True), flush=True)

    manifest = json.loads(Path(args.manifest).read_text('utf-8'))
    started = time.monotonic()
    try:
        folder = model_directory(args.engine, args.models_root, args.bundled, manifest)
        model = SpeechModel(args.engine, folder, args.device, args.language)
    except Exception as error:
        emit('fatal', error=str(error) if str(error) in ['model-missing', 'device'] else 'runtime')
        return
    emit('loaded', device=model.device, fallback=model.fallback, seconds=round(time.monotonic() - started, 3))
    if args.wav:
        started = time.monotonic()
        samples = read_wav(args.wav)
        text = model.transcribe(samples, args.language)
        emit('test', text=text, seconds=round(time.monotonic() - started, 3), duration=len(samples) / 16000, device=model.device)
        model.close()
        return

    commands = queue.Queue(maxsize=8)

    def reader():
        for line in sys.stdin:
            try:
                if len(line) <= 2048:
                    commands.put(json.loads(line))
            except (ValueError, TypeError):
                pass
        commands.put({'action': 'quit'})

    threading.Thread(target=reader, daemon=True).start()
    def start_session(command):
        from native_asr import record
        import numpy as np
        session = {'id': command['id'], 'device': model.device, 'microphone': command.get('microphone', '')}
        stop = threading.Event()
        done = threading.Event()
        segments = queue.Queue(maxsize=3)

        def infer():
            def fixture_capture():
                import webrtcvad
                from native_asr import Segmenter, FRAME
                segmenter = Segmenter(webrtcvad.Vad(2).is_speech)
                fixture = Path(args.capture_wav)
                if fixture.is_dir():
                    fixture = fixture / ('en.wav' if command['language'].startswith('en') else 'zh.wav')
                samples = read_wav(fixture)
                emit('ready', session, device=model.device)
                for at in range(0, len(samples) - FRAME + 1, FRAME):
                    if stop.is_set():
                        break
                    chunk = samples[at:at + FRAME]
                    emit('level', session, level=min(100, int(np.sqrt(np.mean(chunk * chunk)) * 500)))
                    segment = segmenter.push((chunk * 32767).astype('<i2').tobytes())
                    if segment:
                        segments.put(segment)
                    time.sleep(.03)
                final = segmenter.flush()
                if final:
                    segments.put(final)
                segments.put(None)
            capture = threading.Thread(target=fixture_capture if args.capture_wav else record,
                                       args=() if args.capture_wav else (stop, emit, session, segments), daemon=True)
            capture.start()
            try:
                while True:
                    segment = segments.get()
                    if segment is None:
                        break
                    emit('processing', session)
                    text = model.transcribe(np.frombuffer(segment, '<i2').astype(np.float32) / 32768, command['language'])
                    if text:
                        emit('text', session, text=text)
            except Exception:
                stop.set()
                emit('error', session, error='inference')
            finally:
                stop.set()
                # Also release a bounded capture queue after inference fails.
                until = time.monotonic() + 1
                while capture.is_alive() and time.monotonic() < until:
                    try:
                        segments.get(timeout=.05)
                    except queue.Empty:
                        pass
                done.set()
                emit('done', session)
                commands.put({'action': 'session-finished'})
        threading.Thread(target=infer, daemon=True).start()
        return Session(stop, done, time.monotonic())

    lifecycle = SessionLifecycle(commands, start_session, idle_seconds)
    try:
        lifecycle.run()
    finally:
        if lifecycle.current:
            lifecycle.current.stop.set()
            lifecycle.current.done.wait(timeout=3)
        model.close()


if __name__ == '__main__':
    main()
