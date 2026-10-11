"""Experimental Piper vocoder acceleration; duration/flow and true tail on CPU.

Phonemization is supplied by the app's existing offline eSpeak WASM worker.
The two original ONNX voices are split before conv_pre; no retraining or graph
approximation. Accelerated 256-frame windows overlap by 32 latent frames;
the last 32 frames use a dynamic CPU decoder to retain the true boundary.
"""
import io
import math
import json
import os
import time
import wave
from pathlib import Path
import numpy as np
import openvino as ov
try:
    from .piper_store import voice_directory
    from .opus_cache import trim_cache
except ImportError:
    from piper_store import voice_directory
    from opus_cache import trim_cache

CPU_CONFIG = {'INFERENCE_NUM_THREADS':2, 'NUM_STREAMS':1,
              'INFERENCE_PRECISION_HINT':'f32', 'PERFORMANCE_HINT':'LATENCY'}
WINDOW, CONTEXT, HOP = 256, 32, 256
CACHE_BUDGET = 256 * 1024 * 1024


def decoder_context(model):
    """Conservative receptive-field radius in input latent frames.

    Shape-only dependencies carry no signal. ConvTranspose adds one input step
    for output phase rounding. The fixed, checksummed graphs have 1D kernels;
    reject changed/nonlocal layouts rather than silently assuming overlap.
    """
    spans = {}
    for node in model.get_ordered_ops():
        kind = node.get_type_name()
        parents = [spans[value.get_node().get_name()] for value in node.input_values()]
        if kind == 'Parameter':
            span = (1.0,0.0)
        elif kind in ('Constant','ShapeOf'):
            span = None
        elif kind in ('Convolution','ConvolutionBackpropData'):
            scale,radius = parents[0]
            attributes = node.get_attributes()
            strides,dilations = attributes['strides'],attributes['dilations']
            kernel = list(node.input_value(1).shape)
            if len(kernel) != 3 or len(strides) != 1 or len(dilations) != 1:
                raise ValueError('Unexpected Piper spatial layout')
            if kind == 'ConvolutionBackpropData':
                new_scale = scale / strides[0]
                span = (new_scale,radius + (kernel[-1]-1)*dilations[0]*new_scale/2 + scale)
            else:
                span = (scale*strides[0],radius + (kernel[-1]-1)*dilations[0]*scale/2)
        elif kind in ('Reshape','Unsqueeze','Squeeze','Broadcast'):
            span = parents[0]
        else:
            values = [s for s in parents if s is not None]
            if values and kind not in ('Add','Subtract','Divide','PRelu','Tanh','Result'):
                raise ValueError('Unexpected nonlocal Piper decoder operation')
            if values and any(s[0] != values[0][0] for s in values):
                raise ValueError('Piper decoder spatial scales do not match')
            span = (values[0][0],max(s[1] for s in values)) if values else None
        spans[node.get_name()] = span
    scale,radius = spans[model.output(0).get_node().get_name()]
    if scale != 1 / HOP:
        raise ValueError('Unexpected Piper hop length')
    return math.ceil(radius)


def split_vocoder(model):
    model = model.clone()
    candidates = [n for n in model.get_ordered_ops()
                  if n.friendly_name == '/dec/conv_pre/Conv/WithoutBiases' and n.get_type_name() == 'Convolution']
    if len(candidates) != 1:
        raise ValueError('Unexpected Piper decoder')
    first = candidates[0]
    feature = first.input_value(0)
    channels = feature.partial_shape[1].get_length()
    if channels not in (96, 192):
        raise ValueError('Unexpected Piper latent channels')
    upstream = ov.Model([feature], model.get_parameters())
    upstream.reshape({'input':[1,-1], 'input_lengths':[1]})
    parameter = ov.opset13.parameter([1, channels, -1], np.float32, name='latent')
    first.input(0).replace_source_output(parameter.output(0))
    vocoder = ov.Model(model.outputs, [parameter])
    # Only local 1D convolutions and elementwise operations may enter the
    # stitched decoder. Pinned model hashes fix their kernels and dilations.
    allowed = {'Parameter','Result','Constant','Convolution','ConvolutionBackpropData',
               'Reshape','Add','PRelu','Divide','Tanh','Unsqueeze','Squeeze',
               'ShapeOf','Subtract','Broadcast','Concat'}
    if any(n.get_type_name() not in allowed for n in vocoder.get_ordered_ops()):
        raise ValueError('Piper decoder contains a nonlocal operation')
    if decoder_context(vocoder) > CONTEXT:
        raise ValueError('Piper decoder requires more overlap')
    return upstream, vocoder, channels


def pcm_wav(audio, sample_rate):
    if not np.isfinite(audio).all():
        raise RuntimeError('Piper returned nonfinite audio')
    pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


try:
    from .cache_lease import cache_user
except ImportError:
    from cache_lease import cache_user


@cache_user
class NativePiper:
    def __init__(self, voice='en_US-lessac-low'):
        self.voice = voice
        folder = voice_directory(voice)
        self.config = json.loads((folder / (voice + '.onnx.json')).read_text('utf-8'))
        self.sample_rate = self.config['audio']['sample_rate']
        if self.sample_rate != 16000 or self.config.get('speaker_id_map'):
            raise ValueError('Unsupported Piper configuration')
        self.valid_ids = {i for ids in self.config['phoneme_id_map'].values() for i in ids}
        self.core = ov.Core()
        self.upstream, self.vocoder, self.channels = split_vocoder(self.core.read_model(folder / (voice + '.onnx')))
        cache = Path(os.environ.get('SURFACETAB_PIPER_CACHE',
                     str(Path(os.environ.get('LOCALAPPDATA', str(folder))) / 'SurfaceTab/piper-openvino-cache')))
        self.cache = cache / 'vocoder256-context32-v1' / ov.__version__
        self.cache.mkdir(parents=True, exist_ok=True)
        self.core.set_property({'CACHE_DIR':str(self.cache)})
        trim_cache(self.cache, CACHE_BUDGET)
        self.sessions, self.failures = {}, {}
        self.encoder_device = 'CPU'  # Compatibility with the shared health API.

    def check(self):
        if self.cancelled is not None and self.cancelled.is_set():
            raise InterruptedError('Speech synthesis cancelled')
        if time.monotonic() > self.deadline:
            raise TimeoutError('Speech synthesis timed out')

    def session(self, stage, device):
        key = stage, device
        self.check()
        if key not in self.sessions:
            started = time.perf_counter()
            model = (self.upstream if stage == 'upstream' else self.vocoder).clone()
            if device != 'CPU':
                model.reshape({0:[1,self.channels,WINDOW]})
            config = CPU_CONFIG if device == 'CPU' else {'PERFORMANCE_HINT':'LATENCY'}
            if device == 'GPU':
                config = {**config, 'INFERENCE_PRECISION_HINT':'f16'}
            self.sessions[key] = self.core.compile_model(model, device, config)
            self.compile_ms += (time.perf_counter() - started) * 1000
            trim_cache(self.cache, CACHE_BUDGET)
        self.check()
        return self.sessions[key]

    def infer(self, stage, device, inputs):
        session = self.session(stage, device)
        self.check()
        started = time.perf_counter()
        output = session(inputs)[0].copy()
        self.stage_ms[stage] += (time.perf_counter() - started) * 1000
        self.check()
        if not np.isfinite(output).all():
            raise RuntimeError('Piper returned nonfinite values')
        return output

    def decoder_window(self, latent, device):
        if device == 'CPU':
            return self.infer('vocoder', device, [latent]).ravel()
        padded = np.zeros((1,self.channels,WINDOW), np.float32)
        padded[:,:,:latent.shape[2]] = latent
        return self.infer('vocoder', device, [padded]).ravel()

    def decode(self, latent, requested):
        frames = latent.shape[2]
        if requested == 'CPU' or frames <= CONTEXT * 2:
            self.used.add('CPU')
            return self.decoder_window(latent, 'CPU')
        route = ['NPU','GPU','CPU'] if requested == 'AUTO' else [requested,'CPU']
        available = self.core.available_devices
        for device in route:
            if device not in available or time.monotonic() - self.failures.get(device, (-float('inf'),''))[0] < 300:
                continue
            try:
                if device == 'CPU':
                    audio = self.decoder_window(latent, device)
                else:
                    pieces = []
                    end = frames - CONTEXT
                    for start in range(0,end,WINDOW - 2 * CONTEXT):
                        stop = min(end,start + WINDOW - 2 * CONTEXT)
                        left, right = max(0,start - CONTEXT), stop + CONTEXT
                        decoded = self.decoder_window(latent[:,:,left:right], device)
                        pieces.append(decoded[(start-left)*HOP:(stop-left)*HOP])
                    tail = self.decoder_window(latent[:,:,-2*CONTEXT:], 'CPU')
                    pieces.append(tail[-CONTEXT*HOP:])
                    audio = np.concatenate(pieces)
                if audio.size != frames * HOP:
                    raise RuntimeError('Piper audio length mismatch')
                self.used.add(device)
                self.used.add('CPU')
                self.encoder_device = device
                return audio
            except (InterruptedError, TimeoutError):
                raise
            except Exception as error:
                if device == 'CPU':
                    raise
                self.failures[device] = (time.monotonic(),str(error)[:500])
                self.sessions.pop(('vocoder',device),None)
        raise RuntimeError('No compatible Piper device')

    def synthesize(self, chunks, device='AUTO', cancelled=None):
        if device not in ('AUTO','NPU','GPU','CPU'):
            raise ValueError('Unsupported speech device')
        if not isinstance(chunks,list) or not 1 <= len(chunks) <= 256:
            raise ValueError('Speech requires 1 to 256 phoneme chunks')
        if any(not isinstance(ids,list) or not 3 <= len(ids) <= 1024 or ids[0] != 1 or ids[-1] != 2
               or any(type(i) is not int or i not in self.valid_ids for i in ids) for ids in chunks):
            raise ValueError('Invalid Piper phoneme IDs')
        if sum(map(len,chunks)) > 65536:
            raise ValueError('Speech exceeds the 65536 phoneme limit')
        self.cancelled, self.deadline = cancelled, time.monotonic() + 120
        self.used, self.compile_ms = set(), 0.0
        self.encoder_device = 'CPU'
        self.stage_ms = {'upstream':0.0,'vocoder':0.0}
        started = time.perf_counter()
        self.check()
        inference = self.config['inference']
        scales = np.array([inference['noise_scale'],inference['length_scale'],inference['noise_w']],np.float32)
        pcms, total_samples = [], 0
        for ids in chunks:
            latent = self.infer('upstream','CPU',{'input':np.array([ids],np.int64),
                       'input_lengths':np.array([len(ids)],np.int64),'scales':scales})
            if latent.shape[:2] != (1,self.channels) or not 1 <= latent.shape[2] <= 4096:
                raise ValueError('Speech chunk is too long; select a smaller area')
            audio = self.decode(latent, device)
            total_samples += len(audio)
            if total_samples > self.sample_rate * 1200:
                raise ValueError('Speech exceeds the 20 minute audio limit')
            pcms.append(audio)
        self.check()
        wav = pcm_wav(np.concatenate(pcms), self.sample_rate)
        self.check()
        return {'audio':wav,'sampleRate':self.sample_rate,
                'audioSamples':total_samples,'engine':'Piper OpenVINO (experimental)',
                'voice':self.voice,'vocoderDevices':sorted(self.used),'upstreamDevice':'CPU',
                'tailDevice':'CPU','fallback':any(d in self.failures for d in (['NPU','GPU'] if device == 'AUTO' else [device])),
                'failures':{d:e[1] for d,e in self.failures.items()},'compiledSessions':len(self.sessions),
                'cacheBudgetBytes':CACHE_BUDGET,'timing':{'totalMs':(time.perf_counter()-started)*1000,
                'compileMs':self.compile_ms,'stageMs':self.stage_ms}}
