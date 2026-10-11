"""Experimental q8 linear rewrite for finite FP16 execution.

ONNX MatMulInteger -> int32 Cast -> floating scale can overflow if an accelerator
lowers that Cast to FP16. Dequantize the two bounded operands before MatMul
instead, preserving the existing dynamic quantizer and quantized weights.
No model files are modified. Used only by the explicit experimental OPUS route.
"""
import openvino as ov
from openvino import opset13 as ops


def bounded_quantized_matmuls(graph, required=True):
    count = 0
    for node in graph.get_ordered_ops():
        if node.get_type_name() == 'If':
            count += bounded_quantized_matmuls(node.get_then_body(), required=False)
            count += bounded_quantized_matmuls(node.get_else_body(), required=False)
            continue
        if node.get_type_name() != 'Multiply' or not node.get_friendly_name().endswith('_quant_output_scale_mul'):
            continue
        cast = node.input_value(0).get_node()
        scale = node.input_value(1).get_node()
        if cast.get_type_name() != 'Convert' or scale.get_type_name() != 'Multiply':
            raise ValueError('Unexpected OPUS quantized linear pattern')
        matmul = cast.input_value(0).get_node()
        if matmul.get_type_name() != 'MatMul' or matmul.get_output_element_type(0) != ov.Type.i32:
            raise ValueError('Unexpected OPUS integer accumulator')
        left = ops.multiply(ops.convert(matmul.input_value(0), ov.Type.f32), scale.input_value(0))
        right = ops.multiply(ops.convert(matmul.input_value(1), ov.Type.f32), scale.input_value(1))
        replacement = ops.matmul(left, right, matmul.get_transpose_a(), matmul.get_transpose_b())
        replacement.set_friendly_name(node.get_friendly_name() + '_bounded')
        replacement.output(0).set_names(node.output(0).get_names())
        node.output(0).replace(replacement.output(0))
        count += 1
    if required and not count:
        raise ValueError('OPUS graph contains no expected quantized linears')
    graph.validate_nodes_and_infer_types()
    return count


def exclude_padding_from_quantization(graph):
    """Keep fixed-shape encoder activation ranges equal to the real input length.
    The ONNX dynamic quantizer reduces over all B/T/C values. Attention masks
    alone cannot keep padded hidden states out of these ranges. Zero is already
    included in each quantizer's min/max, so masked zeroes do not expand them.
    Only range reductions change; attention masking and positional inputs stay.
    """
    attention = next(p for p in graph.get_parameters() if p.output(0).get_any_name() == 'attention_mask')
    valid = ops.unsqueeze(ops.greater(attention, ops.constant(0, ov.Type.i64)), ops.constant([2], ov.Type.i64))
    masked = {}
    count = 0
    for node in graph.get_ordered_ops():
        if node.get_type_name() not in ('ReduceMax', 'ReduceMin'):
            continue
        source = node.input_value(0)
        shape = source.get_partial_shape()
        if shape.rank.get_length() != 3:
            raise ValueError('Unexpected OPUS activation range shape')
        key = source.get_node().get_instance_id()
        if key not in masked:
            masked[key] = ops.select(valid, source, ops.constant(0, ov.Type.f32))
        node.input(0).replace_source_output(masked[key].output(0))
        count += 1
    if count != 48:
        raise ValueError('Unexpected number of OPUS activation ranges')
    graph.validate_nodes_and_infer_types()
    return count


def weight_only_encoder_matmuls(graph):
    """Experimental accelerator path: q8 weights, continuous activations.
    Removes ONNX's dynamically quantized activations from encoder linears only;
    keeps the downloaded weights and their zero points/scales unchanged.
    Compare against the same float-activation graph on CPU, not q8 ORT bit parity.
    """
    count = 0
    for node in graph.get_ordered_ops():
        if node.get_type_name() != 'Multiply' or not node.get_friendly_name().endswith('_quant_output_scale_mul'):
            continue
        cast = node.input_value(0).get_node(); scale = node.input_value(1).get_node()
        matmul = cast.input_value(0).get_node()
        ranges = []
        def find_range(value, depth=0):
            if depth > 6:
                return
            current = value.get_node()
            if current.get_type_name() in ('ReduceMin','ReduceMax'):
                ranges.append(current.input_value(0))
                return
            for source in current.input_values():
                find_range(source, depth+1)
        find_range(scale.input_value(0))
        if len(ranges)!=2 or ranges[0].get_node()!=ranges[1].get_node():
            raise ValueError('Cannot recover OPUS encoder float activation')
        right=ops.multiply(ops.convert(matmul.input_value(1),ov.Type.f32),scale.input_value(1))
        replacement=ops.matmul(ranges[0],right,matmul.get_transpose_a(),matmul.get_transpose_b())
        replacement.set_friendly_name(node.get_friendly_name()+'_weight_only')
        replacement.output(0).set_names(node.output(0).get_names());node.output(0).replace(replacement.output(0));count+=1
    if count!=36:
        raise ValueError('Unexpected OPUS encoder linear count')
    graph.validate_nodes_and_infer_types()
    return count
