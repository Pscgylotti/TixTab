"""Translate the offline reference set using bounded, mask-aware native graphs."""
from pathlib import Path
import json
import time
import numpy as np
import openvino as ov
from openvino import opset13 as ops
from openvino.passes import Manager, ConstantFolding
from opus_graph import bounded_quantized_matmuls, exclude_padding_from_quantization
from opus_tokenizer import OpusTokenizer
from opus_graph import weight_only_encoder_matmuls
import os

root = Path('.cache/opus-reference')
references = json.loads((root / 'reference.json').read_text('utf-8'))
core = ov.Core(); core.set_property({'CACHE_DIR': str(Path('.cache/opus-openvino').resolve())})
records = []
for direction in ['en-zh','zh-en']:
    folder = Path('public/models/opus-'+direction)
    tokenizer = OpusTokenizer(folder)
    cases = [r for r in references if r['direction']==direction and not r['padding']]
    decoders = {}
    start = time.perf_counter()
    for cached in (False,True):
        graph = core.read_model(folder/'onnx/decoder_model_merged_quantized.onnx')
        branch = next(p for p in graph.get_parameters() if p.output(0).get_any_name()=='use_cache_branch')
        branch.output(0).replace(ops.constant([cached]).output(0));graph.remove_parameter(branch)
        passes=Manager();passes.register_pass(ConstantFolding());passes.run_passes(graph)
        bounded_quantized_matmuls(graph)
        decoders[cached]=core.compile_model(graph,'CPU',{'PERFORMANCE_HINT':'LATENCY','INFERENCE_NUM_THREADS':2,'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'})
    print(json.dumps({'direction':direction,'decoderCompileMs':(time.perf_counter()-start)*1000}),flush=True)

    def decode(states, n):
        cache={f'past_key_values.{layer}.{kind}.{value}':np.zeros((1,8,0,64),np.float32) for layer in range(6) for kind in ['decoder','encoder'] for value in ['key','value']}
        tokens=[65000]
        for step in range(256):
            feeds={'input_ids':np.array([[tokens[-1]]],np.int64),'encoder_attention_mask':np.ones((1,n),np.int64),'encoder_hidden_states':states,**cache}
            decoder=decoders[step>0];needed={p.get_any_name() for p in decoder.inputs}
            output={p.get_any_name():np.array(v,copy=True) for p,v in decoder({k:v for k,v in feeds.items() if k in needed}).items()}
            logits=output['logits'][0,-1]
            if not np.isfinite(logits).all():raise ValueError('Non-finite decoder logits')
            logits[65000]=-np.inf;token=int(logits.argmax());tokens.append(token)
            if token==0:return tokens
            for key in cache:
                if '.encoder.' not in key or step==0:cache[key]=output[key.replace('past_key_values.','present.')]
        raise ValueError('Decoder exceeded 256 tokens')

    for device in ['gold-states','CPU','GPU','NPU']:
        encoder=None
        if device!='gold-states':
            graph=core.read_model(folder/'onnx/encoder_model_quantized.onnx')
            graph.reshape({'input_ids':[1,64],'attention_mask':[1,64]})
            if os.environ.get('SURFACETAB_PROBE_WEIGHT_ONLY') == '1':weight_only_encoder_matmuls(graph)
            else:bounded_quantized_matmuls(graph);exclude_padding_from_quantization(graph)
            config={'PERFORMANCE_HINT':'LATENCY'}
            if device!='NPU':config.update({'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'})
            if device=='CPU':config['INFERENCE_NUM_THREADS']=2
            start=time.perf_counter();encoder=core.compile_model(graph,device,config);compile_ms=(time.perf_counter()-start)*1000
        for sample in cases:
            record={'direction':direction,'device':device,'text':sample['text']}
            try:
                ids=tokenizer.encode(sample['text'],direction);n=len(ids)
                if ids!=sample['ids']:raise ValueError('Tokenizer mismatch')
                start=time.perf_counter()
                if device=='gold-states':states=np.fromfile(root/sample['stateFile'],np.float32).reshape(1,n,512)
                else:
                    padded=np.full((1,64),65000,np.int64);padded[0,:n]=ids;mask=np.zeros((1,64),np.int64);mask[0,:n]=1
                    states=np.array(encoder({'input_ids':padded,'attention_mask':mask})[0][:,:n,:],copy=True)
                if not np.isfinite(states).all():raise ValueError('Non-finite encoder states')
                record['encoderMs']=(time.perf_counter()-start)*1000
                start=time.perf_counter();tokens=decode(states,n)
                record.update({'decoderMs':(time.perf_counter()-start)*1000,'tokens':tokens,'translation':tokenizer.decode(tokens),'reference':sample['translation'],'tokensMatch':tokens==sample['tokens']})
            except Exception as error:record['error']=str(error)
            records.append(record);print(json.dumps(record,ensure_ascii=True),flush=True)
        encoder=None
suffix='-weight-only' if os.environ.get('SURFACETAB_PROBE_WEIGHT_ONLY') == '1' else ''
Path('.cache/opus-translation-parity'+suffix+'.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n','utf-8')
