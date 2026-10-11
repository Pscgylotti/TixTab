import openvino as ov, json
c=ov.Core(); print(ov.__version__); print(c.available_devices)
for d in c.available_devices:
 try:print(d,c.get_property(d,'FULL_DEVICE_NAME'))
 except Exception as e:print(str(e)[:200])
for f in ['encoder_model.onnx','decoder_model_merged.onnx']:
 m=c.read_model('public/models/texo/onnx/'+f);print(f)
 for p in m.inputs:print('in',p.get_any_name(),p.get_partial_shape(),p.get_element_type())
 for p in m.outputs:print('out',p.get_any_name(),p.get_partial_shape(),p.get_element_type())
