"""Compare real encoder values against offline ORT CPU, with finite-value checks.
Exploration only: does not change app routing, weights or installed runtime.
"""
from pathlib import Path
import json
import time
import numpy as np
import openvino as ov
import os
from opus_graph import bounded_quantized_matmuls, exclude_padding_from_quantization

root = Path('.cache/opus-reference')
references = json.loads((root / 'reference.json').read_text('utf-8'))
core = ov.Core()
core.set_property({'CACHE_DIR': str(Path('.cache/opus-openvino').resolve())})
records = []
for direction in ['en-zh', 'zh-en']:
    sample = next(r for r in references if r['direction'] == direction and r['index'] == 0 and not r['padding'])
    ids = sample['ids']; n = len(ids)
    exact = np.fromfile(root / sample['stateFile'], np.float32).reshape(1,n,512)
    padded_ref = next(r for r in references if r['direction'] == direction and r['index'] == 0 and r['padding'])
    padded = np.fromfile(root / padded_ref['stateFile'], np.float32).reshape(1,n,512)
    print(json.dumps({'direction': direction, 'ortPaddingMae': float(np.mean(np.abs(exact-padded))), 'ortPaddingMax': float(np.max(np.abs(exact-padded)))}), flush=True)
    for length in [n,128]:
        for device, precision in [('CPU','f32'),('GPU','default'),('GPU','f32'),('NPU','default')]:
            record = {'direction':direction,'length':length,'device':device,'precision':precision}
            try:
                graph = core.read_model(Path('public/models/opus-'+direction+'/onnx/encoder_model_quantized.onnx'))
                if os.environ.get('SURFACETAB_PROBE_BOUNDED') == '1':
                    record['boundedLinears'] = bounded_quantized_matmuls(graph)
                graph.reshape({'input_ids':[1,length],'attention_mask':[1,length]})
                if os.environ.get('SURFACETAB_PROBE_MASKED') == '1':
                    record['maskedRanges'] = exclude_padding_from_quantization(graph)
                properties = {'PERFORMANCE_HINT':'LATENCY'}
                if device == 'CPU': properties.update({'INFERENCE_NUM_THREADS':2})
                if precision == 'f32': properties.update({'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'})
                start=time.perf_counter(); model=core.compile_model(graph,device,properties);record['compileMs']=(time.perf_counter()-start)*1000
                inputs=np.full((1,length),65000,np.int64);inputs[0,:n]=ids
                mask=np.zeros((1,length),np.int64);mask[0,:n]=1
                start=time.perf_counter(); values=np.array(model({'input_ids':inputs,'attention_mask':mask})[0][:,:n,:],copy=True);record['inferenceMs']=(time.perf_counter()-start)*1000
                gold=exact if length==n or os.environ.get('SURFACETAB_PROBE_MASKED') == '1' else padded
                finite=bool(np.isfinite(values).all());record.update({'finite':finite,'nonfiniteValues':int((~np.isfinite(values)).sum())})
                if finite:
                    record.update({'maeVsOrt':float(np.mean(np.abs(values-gold))),'maxVsOrt':float(np.max(np.abs(values-gold))),'rms':float(np.sqrt(np.mean(values**2))),'goldRms':float(np.sqrt(np.mean(gold**2))),'cosine':float(np.dot(values.flatten(),gold.flatten()) / (np.linalg.norm(values)*np.linalg.norm(gold)))})
                np.save(root/f"{direction}-{device}-{precision}-{length}.npy",values)
                model=None
            except Exception as error: record['error']=str(error)
            records.append(record);print(json.dumps(record,ensure_ascii=True),flush=True)
suffix = '-bounded' if os.environ.get('SURFACETAB_PROBE_BOUNDED') == '1' else ''
suffix += '-masked' if os.environ.get('SURFACETAB_PROBE_MASKED') == '1' else ''
Path('.cache/opus-encoder-parity'+suffix+'.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n','utf-8')
