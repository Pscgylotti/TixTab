"""True batched line inference; classifier and TopK remain on the device.

Same experimental approximations as tesseract_graph.py. This separate builder
keeps the measured batch-1 prototype unchanged for reproducible comparisons.
"""
import numpy as np
import openvino as ov
from openvino import opset13 as op


def build_batch_graph(tess, width, batch):
    if width not in (384, 768, 1536) or batch not in (1, 2, 4):
        raise ValueError("Supported experimental profiles: width 384/768/1536, batch 1/2/4")
    source = op.parameter([batch, tess.input_height, width, 1], np.float32, name="lines")

    def constant(value, dtype=np.int64):
        return op.constant(np.asarray(value, dtype=dtype))

    def transpose(value, order):
        return op.transpose(value, constant(order))

    def reshape(value, shape):
        return op.reshape(value, constant(shape), False)

    def recurrent(value, layer, reverse=False):
        b, h, w, features = value.get_output_shape(0)
        hidden = layer.no
        gates = np.concatenate([layer.weights[i] for i in (2, 1, 0, 3)], axis=0)
        cell = op.lstm_sequence(reshape(value, [b*h, w, features]),
            constant(np.zeros((b*h, 1, hidden)), np.float32),
            constant(np.zeros((b*h, 1, hidden)), np.float32), constant([w]*(b*h)),
            constant(gates[None, :, :features], np.float32),
            constant(gates[None, :, features:-1], np.float32),
            constant(gates[None, :, -1], np.float32), hidden,
            direction="reverse" if reverse else "forward")
        if layer.kind == "SummLSTM":
            return reshape(cell.output(1), [b, h, 1, hidden])
        return reshape(cell.output(0), [b, h, w, hidden])

    def apply(layer, value):
        if layer.kind == "Input":
            if layer.params != (1, tess.input_height, 0, 1, 0):
                raise ValueError("Unexpected input shape")
            return value
        if layer.kind == "Series":
            children = layer.children
            if len(children) == 2 and children[0].kind == "Convolve" and children[1].kind == "Tanh":
                x, y = children[0].params
                channels = value.get_output_shape(0)[-1]
                weights = children[1].weights[0]
                kernel = weights[:, :-1].reshape(-1, 2*x+1, 2*y+1, channels).transpose(0, 3, 2, 1)
                conv = op.convolution(transpose(value, [0, 3, 1, 2]), constant(kernel, np.float32),
                                      [1, 1], [y, x], [y, x], [1, 1])
                out = op.tanh(op.add(conv, constant(weights[:, -1][None, :, None, None], np.float32)))
                return transpose(out, [0, 2, 3, 1])
            for child in children:
                value = apply(child, value)
            return value
        if layer.kind == "Maxpool":
            x, y = layer.params
            pool = op.max_pool(transpose(value, [0, 3, 1, 2]), [y, x], [1, 1],
                               [0, 0], [0, 0], [y, x], rounding_type="floor")
            return transpose(pool.output(0), [0, 2, 3, 1])
        if layer.kind == "XYTranspose":
            if len(layer.children) != 1 or layer.children[0].kind != "SummLSTM":
                raise ValueError("Unexpected vertical layer")
            return transpose(recurrent(transpose(value, [0, 2, 1, 3]), layer.children[0]), [0, 2, 1, 3])
        if layer.kind == "RTLReversed":
            if len(layer.children) != 1 or layer.children[0].kind != "LSTM":
                raise ValueError("Unexpected reverse layer")
            return recurrent(value, layer.children[0], True)
        if layer.kind == "LSTM":
            return recurrent(value, layer)
        if layer.kind == "Softmax":
            weights = layer.weights[0]
            logits = op.add(op.matmul(value, constant(weights[:, :-1], np.float32), False, True),
                            constant(weights[:, -1], np.float32))
            return op.softmax(logits, -1)
        raise ValueError("Unsupported batch layer: " + layer.kind)

    probabilities = apply(tess.root, source)
    # Float reduction argmax avoids this NPU driver's unreliable TopK integer
    # output on batched lines. Ties choose the first class, like NumPy argmax.
    # The entire probability/classifier computation still runs on the device.
    maximum = op.reduce_max(probabilities, constant([-1]), True)
    indices = constant(np.arange(tess.root.no, dtype=np.float32), np.float32)
    selected = op.select(op.equal(probabilities,maximum),indices,
                         constant(tess.root.no,np.float32))
    output = op.reduce_min(selected,constant([-1]),False)
    output = reshape(output, [batch*(width//3)])
    return ov.Model([output], [source], f"tesseract-english-batch-{batch}")
