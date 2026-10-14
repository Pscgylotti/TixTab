"""Optional local Texo / experimental OPUS acceleration, loopback port 8766."""
import threading
import time
import asyncio
import importlib.util
import json
from contextlib import asynccontextmanager
from typing import Annotated, Literal
import openvino as ov
try:
    from .cache_lease import CacheBusyError
    from .request_lifecycle import wait_native_request
except ImportError:
    from cache_lease import CacheBusyError
    from request_lifecycle import wait_native_request
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
try:
    from .native_texo import NativeTexo
    from .native_opus import NativeOpus
except ImportError:
    from native_texo import NativeTexo
    from native_opus import NativeOpus

_model = None
_model_kind = None
_last_used = 0.0
_lock = threading.Lock()
_devices = None
_idle_handle = None
IDLE_RELEASE_SECONDS = 1800


def drop_model():
    global _model, _model_kind
    previous = _model
    _model = None
    _model_kind = None
    if previous is not None and callable(getattr(previous, 'close', None)):
        previous.close()


def cancel_idle_release():
    global _idle_handle
    if _idle_handle is not None:
        _idle_handle.cancel()
        _idle_handle = None


def schedule_idle_release():
    """One deadline per completed request; no recurring idle wake-ups."""
    global _idle_handle
    cancel_idle_release()
    if _model is not None:
        _idle_handle = asyncio.get_running_loop().call_later(
            IDLE_RELEASE_SECONDS, release_idle_model)


def release_idle_model():
    global _model, _model_kind, _idle_handle
    _idle_handle = None
    if _lock.acquire(blocking=False):
        try:
            remaining = IDLE_RELEASE_SECONDS - (time.monotonic() - _last_used)
            if _model is not None and remaining <= 0:
                drop_model()
            elif _model is not None:
                _idle_handle = asyncio.get_running_loop().call_later(remaining, release_idle_model)
        finally:
            _lock.release()


@asynccontextmanager
async def lifetime(app):
    global _model, _model_kind
    try:
        yield
    finally:
        cancel_idle_release()
        drop_model()


app = FastAPI(title='TixTab local OpenVINO', lifespan=lifetime)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'])
app.add_middleware(CORSMiddleware,
                   allow_origins=['http://127.0.0.1:5173', 'http://localhost:5173', 'surfacetab://app'],
                   allow_methods=['GET', 'POST'], allow_headers=['Content-Type'],
                   expose_headers=['X-SurfaceTab-Speech'])


class ModelPolicy(BaseModel):
    idleReleaseSeconds: int = Field(default=1800, strict=True, ge=30, le=86400)


class RecognizeRequest(ModelPolicy):
    image: str = Field(max_length=4_000_000)
    device: Literal['AUTO', 'CPU', 'GPU', 'NPU'] = 'AUTO'


class TranslateRequest(ModelPolicy):
    text: str = Field(min_length=1, max_length=10000)
    direction: Literal['en-zh', 'zh-en']
    device: Literal['AUTO', 'CPU', 'GPU', 'NPU'] = 'AUTO'


class ReleaseRequest(BaseModel):
    action: Literal['release-idle']


@app.post('/models/release')
async def release_models(body: ReleaseRequest, request: Request):
    """Free idle sessions only; never cancel work or touch model/cache files."""
    global _model, _model_kind
    origin = request.headers.get('origin')
    if origin and origin not in ['http://127.0.0.1:5173', 'http://localhost:5173', 'surfacetab://app']:
        raise HTTPException(403, 'Untrusted origin')
    if not _lock.acquire(blocking=False):
        raise HTTPException(429, 'A local inference request is already running')
    try:
        cancel_idle_release()
        released = _model is not None
        drop_model()
        return {'ok': True, 'engine': 'SurfaceTab model lifecycle', 'loaded': False, 'released': released}
    finally:
        _lock.release()


@app.post('/models/config')
async def configure_models(body: ModelPolicy, request: Request):
    global IDLE_RELEASE_SECONDS
    origin = request.headers.get('origin')
    if origin and origin not in ['http://127.0.0.1:5173', 'http://localhost:5173', 'surfacetab://app']:
        raise HTTPException(403, 'Untrusted origin')
    IDLE_RELEASE_SECONDS = body.idleReleaseSeconds
    # A busy request schedules its own deadline on completion. Never unload it.
    if not _lock.locked():
        cancel_idle_release()
        release_idle_model()
    return {'ok': True, 'idleReleaseSeconds': IDLE_RELEASE_SECONDS}


PhonemeId = Annotated[int, Field(strict=True, ge=0, le=4096)]
PhonemeChunk = Annotated[list[PhonemeId], Field(min_length=3, max_length=1024)]


class SpeechRequest(ModelPolicy):
    voice: Literal['en_US-lessac-low', 'zh_CN-huayan-x_low']
    chunks: list[PhonemeChunk] = Field(min_length=1, max_length=256)
    device: Literal['AUTO', 'CPU', 'GPU', 'NPU'] = 'AUTO'


@app.get('/health')
def health():
    global _devices
    if _devices is None:
        core = ov.Core()
        _devices = [{'id': d, 'name': core.get_property(d, 'FULL_DEVICE_NAME')} for d in core.available_devices]
    return {'ok': True, 'engine': 'Texo OpenVINO', 'version': ov.__version__, 'devices': _devices,
            'loaded': _model is not None, 'encoderDevice': _model.encoder_device if _model else None,
            'decoderDevice': _model.encoder_device if _model_kind == ('unimumer', None) and _model else 'CPU', 'idleReleaseSeconds': IDLE_RELEASE_SECONDS,
            'capabilities': ['recognize', 'unimumer-experimental', 'translate-experimental', 'synthesize-experimental', 'release-idle', 'idle-policy-v1', 'cache-lease-v1'] + (['ocr-experimental'] if importlib.util.find_spec('rapidocr') else []),
            'modelKind': _model_kind if _model is not None else None}


@app.post('/recognize')
async def recognize(body: RecognizeRequest, request: Request):
    return await run_native(request, ('texo', None), NativeTexo,
                            lambda model, cancelled: model.recognize(body.image, body.device, cancelled=cancelled))


def create_unimumer():
    try:
        from .native_unimumer import NativeUnimumer
    except ImportError:
        from native_unimumer import NativeUnimumer
    return NativeUnimumer()


class UnimumerRequest(ModelPolicy):
    image: str = Field(max_length=4_000_000)
    device: Literal['AUTO', 'CPU', 'GPU'] = 'AUTO'


@app.post('/recognize-unimumer')
async def recognize_unimumer(body: UnimumerRequest, request: Request):
    return await run_native(request, ('unimumer', None), create_unimumer,
                            lambda model, cancelled: model.recognize(body.image, body.device, cancelled=cancelled))


@app.post('/translate')
async def translate(body: TranslateRequest, request: Request):
    if not body.text.strip():raise HTTPException(400, 'Translation text is empty')
    return await run_native(request, ('opus', body.direction), lambda: NativeOpus(direction=body.direction),
                            lambda model, cancelled: model.translate(body.text, body.device, cancelled=cancelled))


def create_ocr():
    # The optional OCR dependencies must not prevent Texo/OPUS from starting.
    try:
        from .native_ocr import NativeOcr
    except ImportError:
        from native_ocr import NativeOcr
    return NativeOcr()


@app.post('/ocr')
async def ocr(body: RecognizeRequest, request: Request):
    return await run_native(request, ('ocr', None), create_ocr,
                            lambda model, cancelled: model.recognize(body.image, body.device, cancelled=cancelled))


def create_piper(voice):
    try:
        from .native_piper import NativePiper
    except ImportError:
        from native_piper import NativePiper
    return NativePiper(voice)


def speech_response(model, body, cancelled):
    result = model.synthesize(body.chunks, body.device, cancelled=cancelled)
    audio = result.pop('audio')
    return Response(audio, media_type='audio/wav',
                    headers={'X-SurfaceTab-Speech':json.dumps(result, separators=(',',':'))})


@app.post('/synthesize')
async def synthesize(body: SpeechRequest, request: Request):
    if sum(map(len,body.chunks)) > 65536:
        raise HTTPException(400, 'Speech exceeds the 65536 phoneme limit')
    return await run_native(request, ('piper', body.voice), lambda:create_piper(body.voice),
                            lambda model,cancelled:speech_response(model,body,cancelled))


async def run_native(request, kind, factory, invoke):
    global _model, _model_kind, _last_used, IDLE_RELEASE_SECONDS
    policy = await request.json()
    IDLE_RELEASE_SECONDS = policy.get("idleReleaseSeconds", IDLE_RELEASE_SECONDS)
    if not _lock.acquire(blocking=False):
        raise HTTPException(429, 'A local inference request is already running')
    cancelled = threading.Event()
    cancel_idle_release()
    def run():
        global _model, _model_kind
        if _model is None or _model_kind != kind:
            # Release the previous model before loading another task/direction.
            drop_model()
            if cancelled.is_set():raise InterruptedError()
            try:
                _model = factory()
            except ValueError as error:
                # Missing/corrupt/incompatible models are backend failures, not
                # rejected user input; allow the bundled WASM fallback.
                raise RuntimeError('Local model unavailable: ' + str(error)) from error
            _model_kind = kind
        return invoke(_model, cancelled)
    task = asyncio.create_task(asyncio.to_thread(run))
    reset_model = False
    try:
        # request.json() above has fully consumed the HTTP body. Listen once
        # for disconnect instead of waking every 100 ms during native work.
        return await wait_native_request(task, request.receive, cancelled)
    except CacheBusyError as error:
        raise HTTPException(429, 'Native cache maintenance is running') from error
    except InterruptedError as error:
        raise HTTPException(499, 'Local inference cancelled') from error
    except TimeoutError as error:
        raise HTTPException(504, 'Local inference timed out') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:
        # A failed driver/model session should not poison the next request.
        # A receive-channel error can happen while native work is still using
        # the model. Dispose only after the worker finishes, with the lock held.
        reset_model = True
        raise HTTPException(503, 'OpenVINO unavailable: ' + str(error)[:1500]) from error
    finally:
        # Keep the lock until native work finishes, including on HTTP cancellation.
        cancelled.set()
        if not task.done():
            try:
                await asyncio.shield(task)
            except Exception:
                pass
        try:
            if reset_model:
                drop_model()
        finally:
            _last_used = time.monotonic()
            _lock.release()
            schedule_idle_release()
