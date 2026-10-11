"""Experimental local OPUS engine, explicitly selected by the user.

Reuse verified bundled q8 weights. Continuous encoder activations avoid NPU
integer-accumulator overflow; cached q8 decoding stays on a two-thread CPU.
This changes quantization semantics relative to the existing WASM model, so
translation quality must be checked before enabling it as an application default.
"""
from collections import OrderedDict
from pathlib import Path
import json
import re
import time
import numpy as np
import openvino as ov
from openvino import opset13 as ops
from openvino.passes import Manager, ConstantFolding
try:
    from .opus_graph import bounded_quantized_matmuls, weight_only_encoder_matmuls
    from .opus_tokenizer import OpusTokenizer
    from .opus_store import FILES, model_directory, verify_files
    from .opus_cache import cache_directory, trim_cache, CACHE_BUDGET
except ImportError:
    from opus_graph import bounded_quantized_matmuls, weight_only_encoder_matmuls
    from opus_tokenizer import OpusTokenizer
    from opus_store import FILES, model_directory, verify_files
    from opus_cache import cache_directory, trim_cache, CACHE_BUDGET


def check_cancel(cancelled, deadline):
    if cancelled is not None and cancelled.is_set():
        raise InterruptedError('Translation cancelled')
    if time.monotonic()>deadline:
        raise TimeoutError('Translation inference timed out')


try:
    from .cache_lease import cache_user
except ImportError:
    from cache_lease import cache_user


@cache_user
class NativeOpus:
    def __init__(self, folder=None, direction='en-zh'):
        if direction not in ('en-zh','zh-en'):
            raise ValueError('Unsupported translation direction')
        self.folder=Path(folder) if folder else model_directory(direction);self.direction=direction
        if folder:verify_files(self.folder,direction)
        self.config=json.loads((self.folder/'config.json').read_text('utf-8'))
        expected={'model_type':'marian','d_model':512,'decoder_layers':6,'decoder_attention_heads':8,
                  'decoder_start_token_id':65000,'pad_token_id':65000,'eos_token_id':0,'max_position_embeddings':512}
        if any(self.config.get(key)!=value for key,value in expected.items()):
            raise ValueError('Unsupported OPUS model configuration')
        self.tokenizer=OpusTokenizer(self.folder)
        self.core=ov.Core();self.decoders={};self.encoders=OrderedDict()
        self.failures={};self.retry_after={};self.encoder_device=''
        self.cache=None
        try:
            self.cache=cache_directory(ov.__version__)
            trim_cache(self.cache)
            self.core.set_property({'CACHE_DIR':str(self.cache)})
        except (OSError,RuntimeError):self.cache=None

    def compile(self, graph, device, config):
        try:
            return self.core.compile_model(graph,device,config)
        finally:
            if self.cache:
                try:trim_cache(self.cache)
                except OSError:pass

    def decoder(self, cached, cancelled, deadline):
        if cached not in self.decoders:
            check_cancel(cancelled,deadline)
            graph=self.core.read_model(self.folder/'onnx/decoder_model_merged_quantized.onnx')
            branch=next(p for p in graph.get_parameters() if p.output(0).get_any_name()=='use_cache_branch')
            branch.output(0).replace(ops.constant([cached]).output(0));graph.remove_parameter(branch)
            passes=Manager();passes.register_pass(ConstantFolding());passes.run_passes(graph)
            bounded_quantized_matmuls(graph)
            self.decoders[cached]=self.compile(graph,'CPU',{'PERFORMANCE_HINT':'LATENCY','INFERENCE_NUM_THREADS':2,'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'})
        return self.decoders[cached]

    def encode(self, ids, requested, cancelled, deadline):
        choices=['NPU','GPU','CPU'] if requested=='AUTO' else list(dict.fromkeys([requested,'CPU']))
        n=len(ids);compile_ms=0
        if not 1<=n<=512:raise ValueError('Translation input exceeds 512 tokens')
        for device in choices:
            check_cancel(cancelled,deadline)
            if device not in self.core.available_devices:
                self.failures[device]='Device is unavailable';continue
            if time.monotonic()<self.retry_after.get(device,0):continue
            try:
                bucket=next(v for v in [16,32,64,128,256,512] if v>=n) if device=='NPU' else 0
                key=(device,bucket)
                if key not in self.encoders:
                    start=time.perf_counter();graph=self.core.read_model(self.folder/'onnx/encoder_model_quantized.onnx')
                    weight_only_encoder_matmuls(graph)
                    graph.reshape({'input_ids':[1,bucket or -1],'attention_mask':[1,bucket or -1]})
                    config={'PERFORMANCE_HINT':'LATENCY'}
                    if device!='NPU':config.update({'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'})
                    if device=='CPU':config['INFERENCE_NUM_THREADS']=2
                    # Discard the least recent shape before compiling another one.
                    while len(self.encoders)>=2:self.encoders.popitem(last=False)
                    self.encoders[key]=self.compile(graph,device,config)
                    compile_ms+=(time.perf_counter()-start)*1000
                model=self.encoders[key];self.encoders.move_to_end(key)
                check_cancel(cancelled,deadline)
                length=bucket or n;padded=np.full((1,length),65000,np.int64);padded[0,:n]=ids
                mask=np.zeros((1,length),np.int64);mask[0,:n]=1
                start=time.perf_counter();states=np.array(model({'input_ids':padded,'attention_mask':mask})[0][:,:n,:],copy=True)
                inference_ms=(time.perf_counter()-start)*1000
                if not np.isfinite(states).all():raise RuntimeError('Non-finite encoder output')
                self.encoder_device=device;self.failures.pop(device,None)
                return states,compile_ms,inference_ms
            except (InterruptedError,TimeoutError):raise
            except Exception as error:
                self.failures[device]=str(error)[:1000];self.retry_after[device]=time.monotonic()+300
                for key in list(self.encoders):
                    if key[0]==device:del self.encoders[key]
        raise RuntimeError('No compatible OPUS encoder device')

    def chunks(self, paragraph):
        for sentence in re.findall(r'[^.!?。！？]+(?:[.!?。！？]+|$)|[.!?。！？]+',paragraph):
            for start in range(0,len(sentence),350):
                pending=[sentence[start:start+350]]
                while pending:
                    piece=pending.pop(0);ids=self.tokenizer.encode(piece,self.direction)
                    if len(ids)<=512:yield piece,ids
                    else:
                        middle=len(piece)//2
                        if middle<1:raise ValueError('Translation token exceeds model input limit')
                        pending[0:0]=[piece[:middle],piece[middle:]]

    def translate(self, text, device='AUTO', cancelled=None):
        if device not in ('AUTO','CPU','GPU','NPU'):raise ValueError('Invalid device')
        if not text.strip() or len(text)>10000:raise ValueError('Translation requires 1–10000 characters')
        started=time.perf_counter();deadline=time.monotonic()+120
        check_cancel(cancelled,deadline)
        paragraphs=[];compile_ms=encoder_ms=decoder_ms=0;token_count=0;devices=[]
        for paragraph in re.split(r'\n\s*\n',text):
            translated=[]
            for piece,ids in self.chunks(paragraph):
                check_cancel(cancelled,deadline)
                if not any(c.isalnum() for c in piece):translated.append(piece);continue
                states,compile_cost,encode_cost=self.encode(ids,device,cancelled,deadline)
                compile_ms+=compile_cost;encoder_ms+=encode_cost;devices.append(self.encoder_device)
                cache={f'past_key_values.{layer}.{kind}.{value}':np.zeros((1,8,0,64),np.float32) for layer in range(6) for kind in ['decoder','encoder'] for value in ['key','value']}
                tokens=[65000];n=len(ids)
                for step in range(256):
                    check_cancel(cancelled,deadline)
                    start=time.perf_counter();was_loaded=(step>0) in self.decoders
                    decoder=self.decoder(step>0,cancelled,deadline)
                    if not was_loaded:compile_ms+=(time.perf_counter()-start)*1000
                    feeds={'input_ids':np.array([[tokens[-1]]],np.int64),'encoder_attention_mask':np.ones((1,n),np.int64),'encoder_hidden_states':states,**cache}
                    needed={p.get_any_name() for p in decoder.inputs};start=time.perf_counter()
                    output={p.get_any_name():np.array(v,copy=True) for p,v in decoder({k:v for k,v in feeds.items() if k in needed}).items()}
                    decoder_ms+=(time.perf_counter()-start)*1000
                    logits=output['logits'][0,-1]
                    if not np.isfinite(logits).all():raise RuntimeError('Non-finite decoder logits')
                    logits[65000]=-np.inf;token=int(logits.argmax());tokens.append(token)
                    if token==0:break
                    for key in cache:
                        if '.encoder.' not in key or step==0:cache[key]=output[key.replace('past_key_values.','present.')]
                if tokens[-1]!=0:raise ValueError('Translation exceeded 256 output tokens; select a smaller region')
                token_count+=len(tokens)-1;translated.append(self.tokenizer.decode(tokens))
            paragraphs.append(('' if self.direction=='en-zh' else ' ').join(translated).strip())
        return {'translation':'\n\n'.join(paragraphs).strip(),'engine':'OPUS OpenVINO (experimental)','encoderDevice':self.encoder_device,'encoderDevices':list(dict.fromkeys(devices)),'decoderDevice':'CPU','requestedDevice':device,'encoderPrecision':'f16' if self.encoder_device=='NPU' else 'f32','encoderQuantization':'q8 weights, continuous activations','fallback':bool(devices) and any(d!=('NPU' if device=='AUTO' else device) for d in devices),'failures':self.failures.copy(),'tokens':token_count,'cacheBudgetBytes':CACHE_BUDGET,'timing':{'totalMs':(time.perf_counter()-started)*1000,'compileMs':compile_ms,'encoderMs':encoder_ms,'decoderMs':decoder_ms}}
