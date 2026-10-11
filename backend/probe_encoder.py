from pathlib import Path
import openvino as ov, numpy as np, time, json
c=ov.Core()
for d in ['CPU','GPU','NPU']:
 try:
  m=c.read_model('public/models/texo/onnx/encoder_model.onnx');m.reshape({'pixel_values':[1,3,384,384]})
  t=time.perf_counter();cm=c.compile_model(m,d,{'PERFORMANCE_HINT':'LATENCY'});compile_ms=(time.perf_counter()-t)*1000
  t=time.perf_counter();o=cm({'pixel_values':np.zeros((1,3,384,384),np.float32)});print(json.dumps({'device':d,'compile_ms':compile_ms,'first_ms':(time.perf_counter()-t)*1000,'out':list(next(iter(o.values())).shape)}),flush=True)
 except Exception as e:print(json.dumps({'device':d,'error':str(e)[:1800]}),flush=True)
