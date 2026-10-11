"""Fair exact-length CPU vs padded-profile NPU encoder benchmark (not power)."""
from pathlib import Path
import json
import time
import gc
import numpy as np
import openvino as ov
from opus_graph import weight_only_encoder_matmuls

core=ov.Core();records=[]
def encode(model,ids,length):
    n=len(ids);padded=np.full((1,length),65000,np.int64);padded[0,:n]=ids
    mask=np.zeros((1,length),np.int64);mask[0,:n]=1
    t=time.perf_counter();values=np.array(model({'input_ids':padded,'attention_mask':mask})[0][:,:n,:],copy=True)
    return values,(time.perf_counter()-t)*1000

for direction,seed in [('en-zh',[26,6930,32,19,3,2270,6]),('zh-en',[7,46998,36,29435,150,9])]:
    path=Path('public/models/opus-'+direction+'/onnx/encoder_model_quantized.onnx')
    def graph(length):
        model=core.read_model(path);weight_only_encoder_matmuls(model)
        model.reshape({'input_ids':[1,length],'attention_mask':[1,length]})
        return model
    options={'PERFORMANCE_HINT':'LATENCY','INFERENCE_NUM_THREADS':2,'INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'}
    start=time.perf_counter();cpu=core.compile_model(graph(-1),'CPU',options);cpu_compile=(time.perf_counter()-start)*1000
    start=time.perf_counter();gpu=core.compile_model(graph(-1),'GPU',{'PERFORMANCE_HINT':'LATENCY','INFERENCE_PRECISION_HINT':'f32','EXECUTION_MODE_HINT':'ACCURACY'});gpu_compile=(time.perf_counter()-start)*1000
    for n in [9,31,97,251]:
        prefix=[5] if direction=='en-zh' else []
        ids=(prefix+(seed*((n+len(seed))//len(seed))))[:n-1]+[0]
        gold,_=encode(cpu,ids,n)
        bucket=next(v for v in [16,32,128,256] if v>=n)
        start=time.perf_counter();npu=core.compile_model(graph(bucket),'NPU',{'PERFORMANCE_HINT':'LATENCY'});npu_compile=(time.perf_counter()-start)*1000
        for device,model,length,compile_ms in [('CPU',cpu,n,cpu_compile),('GPU',gpu,n,gpu_compile),('NPU',npu,bucket,npu_compile)]:
            output,first_ms=encode(model,ids,length);times=[]
            for _ in range(8):output,ms=encode(model,ids,length);times.append(ms)
            finite=bool(np.isfinite(output).all())
            record={'direction':direction,'device':device,'tokens':n,'profileTokens':length,'compileMs':compile_ms,'firstInferenceMs':first_ms,'warmMedianMs':float(np.median(times)),'warmRangeMs':[min(times),max(times)],'finite':finite,'maeVsSameGraphCpu':float(np.mean(np.abs(output-gold))),'maxVsSameGraphCpu':float(np.max(np.abs(output-gold))),'cosineVsSameGraphCpu':float(np.dot(output.flatten(),gold.flatten())/(np.linalg.norm(output)*np.linalg.norm(gold)))}
            records.append(record);print(json.dumps(record),flush=True)
            if not finite:raise ValueError('Non-finite accelerator output')
        npu=None;gc.collect()
    cpu=gpu=None;gc.collect()
Path('.cache/opus-device-benchmark.json').write_text(json.dumps({'graph':'encoder q8 weights, continuous activations; CPU/GPU f32, NPU f16','samples':'synthetic repeated real vocabulary; encoder numerical/latency checks, not translation accuracy','powerMeasured':False,'cacheEnabled':False,'records':records},indent=2)+'\n','utf-8')
