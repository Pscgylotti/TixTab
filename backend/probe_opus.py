from pathlib import Path
import openvino as ov,time
c=ov.Core();folder=Path('public/models/opus-en-zh/onnx')
for name in ['encoder_model_quantized.onnx','decoder_model_merged_quantized.onnx']:
 try:
  m=c.read_model(folder/name)
  print(name,flush=True)
  for p in m.inputs:print('IN',p.get_any_name(),p.get_partial_shape(),p.get_element_type(),flush=True)
  for p in m.outputs:print('OUT',p.get_any_name(),p.get_partial_shape(),flush=True)
  if name.startswith('encoder'):
   m.reshape({'input_ids':[1,128],'attention_mask':[1,128]})
   for device in ['NPU','GPU','CPU']:
    t=time.perf_counter()
    try:c.compile_model(m,device,{'PERFORMANCE_HINT':'LATENCY',**({'INFERENCE_NUM_THREADS':2} if device=='CPU' else {})});print(device,'COMPILED',round((time.perf_counter()-t)*1000),flush=True)
    except Exception as e: print(device,str(e)[:2000],flush=True)
 except Exception as e: print(type(e).__name__,str(e)[:3000],flush=True)
