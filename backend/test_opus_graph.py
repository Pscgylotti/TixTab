"""Numerical regression checks for experimental graph transforms, CPU only."""
import unittest
import numpy as np
import openvino as ov
from openvino import opset13 as ops
from backend.opus_graph import bounded_quantized_matmuls, exclude_padding_from_quantization


class OpusGraphTests(unittest.TestCase):
    def test_bounded_operands_preserve_integer_matmul_and_avoid_fp16_cast_overflow(self):
        activation=ops.parameter([1,1,32],ov.Type.i32,name='activation')
        weights=ops.constant(np.full((32,4),127,np.int32))
        matmul=ops.matmul(activation,weights,False,False)
        scale=ops.multiply(ops.constant(.01,ov.Type.f32),ops.constant(.02,ov.Type.f32))
        scaled=ops.multiply(ops.convert(matmul,ov.Type.f32),scale)
        scaled.set_friendly_name('linear_quant_output_scale_mul')
        graph=ov.Model([scaled],[activation]);core=ov.Core()
        data=np.full((1,1,32),255,np.int32)
        reference=np.array(core.compile_model(graph,'CPU')([data])[0],copy=True)
        self.assertEqual(bounded_quantized_matmuls(graph),1)
        rewritten=np.array(core.compile_model(graph,'CPU')([data])[0],copy=True)
        np.testing.assert_allclose(rewritten,reference,rtol=1e-5,atol=1e-4)
        self.assertGreater(32*255*127,float(np.finfo(np.float16).max))
        for node in graph.get_ordered_ops():
            self.assertFalse(node.get_type_name()=='Convert' and node.input_value(0).get_node().get_type_name()=='MatMul')

    def test_rejects_unrecognized_quantized_patterns(self):
        x=ops.parameter([1],ov.Type.f32)
        with self.assertRaisesRegex(ValueError,'no expected'):
            bounded_quantized_matmuls(ov.Model([x],[x]))

    def test_masked_ranges_match_exact_length_even_with_extreme_padding(self):
        values=ops.parameter([1,4,2],ov.Type.f32,name='values')
        mask=ops.parameter([1,4],ov.Type.i64,name='attention_mask')
        ranges=[]
        for _ in range(24):
            ranges.extend([ops.reduce_min(values,ops.constant([0,1,2],ov.Type.i64)),ops.reduce_max(values,ops.constant([0,1,2],ov.Type.i64))])
        graph=ov.Model(ranges,[values,mask]);self.assertEqual(exclude_padding_from_quantization(graph),48)
        compiled=ov.Core().compile_model(graph,'CPU')
        data=np.array([[[2,-3],[1,-1],[1000,-2000],[5000,-9000]]],np.float32)
        result=compiled({'values':data,'attention_mask':np.array([[1,1,0,0]],np.int64)})
        for i,value in enumerate(result.values()):self.assertAlmostEqual(float(value),-3 if i%2==0 else 2)


if __name__=='__main__':unittest.main()
