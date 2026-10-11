"""Real device compatibility/parity probe; not part of the shipped service."""
from pathlib import Path
import json
import time
import numpy as np
import openvino as ov
from openvino import opset13 as ops
from openvino.passes import Manager, ConstantFolding
from opus_tokenizer import OpusTokenizer

baseline = json.loads(Path('.cache/opus-tokenizer-baseline.json').read_text('utf-8'))
core = ov.Core()
core.set_property({'CACHE_DIR': str(Path('.cache/opus-openvino').resolve())})
records = []
for direction in ['en-zh', 'zh-en']:
    folder = Path('public/models/opus-' + direction)
    tokenizer = OpusTokenizer(folder)
    cases = [r for r in baseline if r['direction'] == direction]
    for r in cases:
        native_ids = tokenizer.encode(r['text'], direction)
        if native_ids != r['ids']:
            print(json.dumps({'tokenizerMismatch': r, 'native': native_ids}, ensure_ascii=True), flush=True)
    config = json.loads((folder / 'config.json').read_text('utf-8'))
    decoders = {}
    t = time.perf_counter()
    for cached in (False, True):
        graph = core.read_model(folder / 'onnx/decoder_model_merged_quantized.onnx')
        branch = next(p for p in graph.get_parameters() if p.output(0).get_any_name() == 'use_cache_branch')
        branch.output(0).replace(ops.constant([cached]).output(0)); graph.remove_parameter(branch)
        passes = Manager(); passes.register_pass(ConstantFolding()); passes.run_passes(graph)
        decoders[cached] = core.compile_model(graph, 'CPU', {'PERFORMANCE_HINT': 'LATENCY', 'INFERENCE_NUM_THREADS': 2, 'INFERENCE_PRECISION_HINT': 'f32'})
    decoder_compile_ms = (time.perf_counter() - t)*1000
    print(json.dumps({'direction': direction, 'decoderCompileMs': decoder_compile_ms}), flush=True)
    for device in ['CPU', 'GPU', 'NPU']:
        try:
            graph = core.read_model(folder / 'onnx/encoder_model_quantized.onnx')
            graph.reshape({'input_ids': [1,128], 'attention_mask': [1,128]})
            t = time.perf_counter(); encoder = core.compile_model(graph, device, {'PERFORMANCE_HINT':'LATENCY', **({'INFERENCE_NUM_THREADS':2,'INFERENCE_PRECISION_HINT':'f32'} if device=='CPU' else {})}); compile_ms=(time.perf_counter()-t)*1000
            for r in cases[:4]:
                ids = tokenizer.encode(r['text'], direction); length=len(ids)
                padded = np.full((1,128), config['pad_token_id'], np.int64); padded[0,:length]=ids
                mask = np.zeros((1,128), np.int64); mask[0,:length]=1
                start=time.perf_counter(); states=np.array(encoder({'input_ids':padded,'attention_mask':mask})[0][:,:length,:],copy=True);encoder_ms=(time.perf_counter()-start)*1000
                cache={f'past_key_values.{layer}.{kind}.{value}':np.zeros((1,config['decoder_attention_heads'],0,config['d_model']//config['decoder_attention_heads']),np.float32) for layer in range(config['decoder_layers']) for kind in ['decoder','encoder'] for value in ['key','value']}
                tokens=[config['decoder_start_token_id']]; t=time.perf_counter()
                for step in range(256):
                    feeds={'input_ids':np.array([[tokens[-1]]],np.int64),'encoder_attention_mask':mask[:,:length],'encoder_hidden_states':states,**cache}
                    decoder=decoders[step>0];needed={p.get_any_name() for p in decoder.inputs}; outputs={p.get_any_name():np.array(v,copy=True) for p,v in decoder({k:v for k,v in feeds.items() if k in needed}).items()}
                    logits=outputs['logits'][0,-1];logits[config['pad_token_id']]=-np.inf;token=int(logits.argmax());tokens.append(token)
                    if token==config['eos_token_id']:break
                    for key in cache:
                        if '.encoder.' not in key or step==0:cache[key]=outputs[key.replace('past_key_values.','present.')]
                rec={'direction':direction,'device':device,'text':r['text'],'translation':tokenizer.decode(tokens),'tokens':tokens,'encoderMs':encoder_ms,'decoderMs':(time.perf_counter()-t)*1000,'compileMs':compile_ms};records.append(rec);print(json.dumps(rec,ensure_ascii=True),flush=True)
            encoder=None
        except Exception as e:print(json.dumps({'direction':direction,'device':device,'error':str(e)},ensure_ascii=True),flush=True)
Path('.cache/opus-native-probe.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n','utf-8')
