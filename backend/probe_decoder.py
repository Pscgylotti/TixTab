import openvino as ov
from openvino import opset13 as ops
from openvino.passes import Manager,ConstantFolding
c=ov.Core()
for branch in [False,True]:
 m=c.read_model('public/models/texo/onnx/decoder_model_merged.onnx');p=next(p for p in m.get_parameters() if p.output(0).get_any_name()=='use_cache_branch');p.output(0).replace(ops.constant([branch]).output(0));m.remove_parameter(p);pm=Manager();pm.register_pass(ConstantFolding());pm.run_passes(m)
 print(branch,[(x.get_type_name(),x.get_friendly_name()) for x in m.get_ops() if x.get_type_name()=='If'],flush=True)
 for o in m.outputs:print(o.get_any_name(),o.get_partial_shape(),flush=True)
 try:cm=c.compile_model(m,'CPU',{'INFERENCE_NUM_THREADS':4});print('COMPILED',flush=True)
 except Exception as e:print(str(e),flush=True)
