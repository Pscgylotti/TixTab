"""Experimental pinned tessdata reader and OpenVINO line recognizer.

This is a development experiment, not a replacement for Tesseract's layout
analysis, DAWG decoder or preprocessing. Format reference: Tesseract 5.5.0
src/lstm/{network,weightmatrix,lstm,plumbing}.cpp (Apache-2.0).
"""
from dataclasses import dataclass, field
import hashlib
from pathlib import Path
import struct

import numpy as np


PINNED = {
    "fast": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "best": "8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba",
    "mixed-best": "4fef2d1306c8e87616d4d3e4c6c67faf5d44be3342290cf8f2f0f6e3aa7e735b",
}
TYPES = ("Invalid Input Convolve Maxpool Parallel Replicated ParBidiLSTM "
         "DepParUDLSTM Par2dLSTM Series Reconfig RTLReversed TTBReversed "
         "XYTranspose LSTM SummLSTM Logistic LinLogistic LinTanh Tanh Relu "
         "Linear Softmax SoftmaxNoCTC LSTMSoftmax LSTMBinarySoftmax TensorFlow").split()


class Reader:
    def __init__(self, data):
        self.data = memoryview(data)
        self.pos = 0

    def take(self, size):
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError("Truncated traineddata")
        result = self.data[self.pos:self.pos + size]
        self.pos += size
        return result

    def scalar(self, fmt="i"):
        return struct.unpack("<" + fmt, self.take(struct.calcsize("<" + fmt)))[0]

    def count(self, limit=1_000_000):
        value = self.scalar("I")
        if value > limit:
            raise ValueError("Traineddata size limit exceeded")
        return value

    def string(self):
        return bytes(self.take(self.count())).decode("utf-8")

    def array(self, dtype, count):
        dtype = np.dtype(dtype)
        return np.frombuffer(self.take(dtype.itemsize * count), dtype=dtype)


@dataclass
class Layer:
    kind: str
    ni: int
    no: int
    name: str
    children: list = field(default_factory=list)
    weights: list = field(default_factory=list)
    params: tuple = ()


def matrix(reader, training):
    if training == 1:
        raise ValueError("Training checkpoints are not supported")
    mode = reader.scalar("B")
    if mode & ~133:
        raise ValueError("Unknown weight encoding")
    rows, cols = reader.count(4096), reader.count(32768)
    if not rows or not cols or rows * cols > 16_000_000:
        raise ValueError("Invalid weight dimensions")
    dtype = "i1" if mode & 1 else ("<f8" if mode & 128 else "<f4")
    reader.take(np.dtype(dtype).itemsize)  # GENERIC_2D_ARRAY empty value.
    values = reader.array(dtype, rows * cols).reshape(rows, cols).astype(np.float32)
    if mode & 1:
        size = reader.count(8192)
        if size < rows:
            raise ValueError("Missing quantization scales")
        scales = reader.array("<f8" if mode & 128 else "<f4", size)[:rows]
        values *= (scales if mode & 128 else scales * 127).astype(np.float32)[:, None]
    if not np.isfinite(values).all():
        raise ValueError("Non-finite weights")
    return values


def network(reader, depth=0):
    if depth > 24:
        raise ValueError("Network nesting limit exceeded")
    ordinal = reader.scalar("B")
    kind = reader.string() if ordinal == 0 else TYPES[ordinal]
    training, _backprop = reader.scalar("b"), reader.scalar("b")
    flags, ni, no, _count = [reader.scalar() for _ in range(4)]
    name = reader.string()
    if not 0 < ni <= 32768 or not 0 < no <= 32768:
        raise ValueError("Invalid layer dimensions")
    layer = Layer(kind, ni, no, name)
    if kind in ("Series", "Parallel", "RTLReversed", "TTBReversed", "XYTranspose"):
        layer.children = [network(reader, depth + 1) for _ in range(reader.count(128))]
        if flags & 64:
            reader.array("<f4", reader.count(128))
    elif kind == "Input":
        layer.params = tuple(reader.scalar() for _ in range(5))
    elif kind in ("Convolve", "Maxpool", "Reconfig"):
        layer.params = (reader.scalar(), reader.scalar())
    elif kind in ("Tanh", "Softmax", "SoftmaxNoCTC", "Linear", "Logistic", "Relu"):
        layer.weights = [matrix(reader, training)]
    elif kind in ("LSTM", "SummLSTM"):
        na = reader.scalar()
        layer.weights = [matrix(reader, training)]
        hidden = layer.weights[0].shape[0]
        if na != ni + hidden:
            raise ValueError("2D or feedback LSTM is not supported")
        layer.weights.extend(matrix(reader, training) for _ in range(3))
        if any(w.shape != (hidden, na + 1) for w in layer.weights):
            raise ValueError("Invalid LSTM gate dimensions")
    else:
        raise ValueError("Unsupported network layer: " + kind)
    return layer


@dataclass
class TessModel:
    root: Layer
    blank: int
    codes: dict
    spec: str
    sha256: str
    input_height: int = 36
    sequences: dict = field(default_factory=dict)

    def decode_classes(self, sequence):
        previous, collapsed = None, []
        for code in sequence:
            code = int(code)
            if code != previous and code != self.blank:
                collapsed.append(code)
            previous = code
        if not self.sequences:
            return ''.join(self.codes.get(code, '\ufffd') for code in collapsed).strip()
        # Pinned Chinese recoder uses disjoint start/continuation alphabets.
        # A Chinese glyph spans 2–5 classifier codes; blank is not a boundary.
        starts = self.codes.keys()
        result, pending = [], []
        for code in collapsed:
            if code in starts and pending:
                result.append(self.sequences.get(tuple(pending), '\ufffd'))
                pending.clear()
            pending.append(code)
        if pending:
            result.append(self.sequences.get(tuple(pending), '\ufffd'))
        return ''.join(result).strip()

    def decode(self, probabilities):
        sequence = np.argmax(probabilities, axis=-1).reshape(-1)
        return self.decode_classes(sequence)


def read_model(path, variant):
    path = Path(path)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Only pinned models up to 32 MiB are supported")
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != PINNED.get(variant):
        raise ValueError("Unknown model; use the documented pinned weights")
    reader = Reader(data)
    if reader.scalar() != 24:
        raise ValueError("Unsupported traineddata archive")
    offsets = [reader.scalar("q") for _ in range(24)]
    def component(index):
        start = offsets[index]
        end = next((o for o in offsets[index + 1:] if o >= 0), len(data))
        if start < 196 or not start <= end <= len(data):
            raise ValueError("Invalid traineddata component")
        return data[start:end]
    net_reader = Reader(component(17))
    root = network(net_reader)
    spec = net_reader.string()
    _flags, _iteration, _sample, blank = [net_reader.scalar() for _ in range(4)]
    charset = component(21).decode("utf-8").splitlines()
    count = int(charset[0])
    chars = [line.split(" ", 1)[0] for line in charset[1:]]
    chars[0] = " "
    recoder = Reader(component(22))
    if recoder.count(4096) != count or len(chars) != count:
        raise ValueError("Charset/recoder size mismatch")
    codes, sequences = {}, {}
    for index in range(count):
        recoder.scalar("B")  # self_normalized
        length = recoder.count(32)
        values = [recoder.scalar() for _ in range(length)]
        if not 1 <= length <= 5:
            raise ValueError("Unsupported character recoding")
        code = values[0]
        if code != blank and index not in (1, 2):
            sequences[tuple(values)] = chars[index]
            codes[code] = chars[index] if length == 1 else ''
    multi = any(len(s) > 1 for s in sequences)
    if multi:
        starts = {s[0] for s in sequences}
        continuations = {c for s in sequences for c in s[1:]}
        if starts & continuations:
            raise ValueError("Ambiguous character recoder requires beam decoding")
    height = root.children[0].params[1]
    if height not in (36, 48) or root.children[0].params != (1, height, 0, 1, 0):
        raise ValueError("Unsupported model input")
    return TessModel(root, blank, codes, spec, digest, height, sequences if multi else {})


def describe(layer):
    return {"kind": layer.kind, "input": layer.ni, "output": layer.no,
            "params": layer.params, "weights": [list(w.shape) for w in layer.weights],
            "children": [describe(c) for c in layer.children]}


def build_graph(tess, width):
    """Build a static single-line graph. See docs for intentional approximations."""
    import openvino as ov
    from openvino import opset13 as op
    if width % 3 or not 24 <= width <= 1536:
        raise ValueError("Width must be a multiple of 3 in [24, 1536]")
    source = op.parameter([tess.input_height, width, 1], np.float32, name="line")
    def const(value, dtype=np.int64):
        return op.constant(np.asarray(value, dtype=dtype))
    def transpose(value, order):
        return op.transpose(value, const(order))
    def linear(value, layer):
        weights = layer.weights[0]
        result = op.add(op.matmul(value, const(weights[:, :-1], np.float32), False, True),
                        const(weights[:, -1], np.float32))
        return {"Tanh": op.tanh, "Logistic": op.sigmoid, "Relu": op.relu,
                "Linear": lambda x: x,
                "Softmax": lambda x: op.softmax(x, -1)}[layer.kind](result)
    def recurrent(value, layer, reverse=False):
        h, w, features = value.get_output_shape(0)
        hidden = layer.no
        # OpenVINO FICO; native serialized order is CIFO.
        gates = np.concatenate([layer.weights[i] for i in (2, 1, 0, 3)], axis=0)
        cell = op.lstm_sequence(value,
            const(np.zeros((h, 1, hidden)), np.float32),
            const(np.zeros((h, 1, hidden)), np.float32), const([w] * h),
            const(gates[None, :, :features], np.float32),
            const(gates[None, :, features:-1], np.float32),
            const(gates[None, :, -1], np.float32), hidden,
            direction="reverse" if reverse else "forward")
        if layer.kind == "SummLSTM":
            return op.squeeze(cell.output(1), const([1]))
        return op.squeeze(cell.output(0), const([1]))
    def apply(layer, value):
        if layer.kind == "Input":
            if layer.params != (1, tess.input_height, 0, 1, 0):
                raise ValueError("Unexpected English input shape")
            return value
        if layer.kind == "Series":
            children = layer.children
            if len(children) == 2 and children[0].kind == "Convolve" and children[1].kind == "Tanh":
                x, y = children[0].params
                channels = value.get_output_shape(0)[-1]
                weights = children[1].weights[0]
                kernel = weights[:, :-1].reshape(-1, 2*x+1, 2*y+1, channels).transpose(0, 3, 2, 1)
                nchw = op.unsqueeze(transpose(value, [2, 0, 1]), const([0]))
                conv = op.convolution(nchw, const(kernel, np.float32), [1, 1], [y, x], [y, x], [1, 1])
                out = op.tanh(op.add(conv, const(weights[:, -1][None, :, None, None], np.float32)))
                return transpose(op.squeeze(out, const([0])), [1, 2, 0])
            for child in children:
                value = apply(child, value)
            return value
        if layer.kind == "Maxpool":
            x, y = layer.params
            nchw = op.unsqueeze(transpose(value, [2, 0, 1]), const([0]))
            pool = op.max_pool(nchw, [y, x], [1, 1], [0, 0], [0, 0], [y, x], rounding_type="floor")
            return transpose(op.squeeze(pool.output(0), const([0])), [1, 2, 0])
        if layer.kind == "XYTranspose":
            if len(layer.children) != 1 or layer.children[0].kind != "SummLSTM":
                raise ValueError("Unexpected vertical LSTM")
            out = recurrent(transpose(value, [1, 0, 2]), layer.children[0])
            return op.unsqueeze(out, const([0]))
        if layer.kind == "RTLReversed":
            if len(layer.children) != 1 or layer.children[0].kind != "LSTM":
                raise ValueError("Unexpected reversed layer")
            return recurrent(value, layer.children[0], reverse=True)
        if layer.kind == "LSTM":
            return recurrent(value, layer)
        if layer.kind in ("Softmax", "Tanh", "Linear", "Logistic", "Relu"):
            return linear(value, layer)
        raise ValueError("Unsupported graph layer: " + layer.kind)
    output = apply(tess.root, source)
    return ov.Model([output], [source], "tesseract-english-experimental")


def prepare_line(image, width, height=36):
    """Pillow normalization for an already segmented line, not a page detector."""
    from PIL import Image
    target = round(image.width * height / image.height)
    if target > width - 6:
        raise ValueError("Line exceeds selected width; use a larger width bucket")
    data = np.ones((height, width, 1), dtype=np.float32)
    with image.convert("L") as gray, gray.resize((max(1, target), height), Image.Resampling.BILINEAR) as resized:
        data[:, 3:3 + max(1, target), 0] = np.asarray(resized, dtype=np.float32) / 127.5 - 1
    return data
