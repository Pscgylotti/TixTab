"""Converter semantics and resource ownership; no GPU/NPU compilation here."""
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
import openvino as ov

from backend.experimental.tesseract_graph import Layer, Reader, TessModel, build_graph, matrix, read_model
from backend.experimental.line_recognizer import LineRecognizer


def native_lstm(values, weights, reverse=False, summary=False):
    batch, width, _ = values.shape
    hidden = weights[0].shape[0]
    h = np.zeros((batch, hidden), np.float32)
    c = h.copy()
    output = np.zeros((batch, width, hidden), np.float32)
    indices = range(width-1, -1, -1) if reverse else range(width)
    for i in indices:
        inputs = np.concatenate([values[:, i], h, np.ones((batch, 1), np.float32)], axis=1)
        candidate = np.tanh(inputs @ weights[0].T)
        gates = [1 / (1 + np.exp(-(inputs @ w.T))) for w in weights[1:]]
        c = np.clip(gates[1]*c + gates[0]*candidate, -100, 100)
        h = np.tanh(c)*gates[2]
        output[:, i] = h
    return h[None, :, :] if summary else output


class ConverterTests(unittest.TestCase):
    def test_truncated_and_oversized_reader(self):
        with self.assertRaises(ValueError):
            Reader(b"\x00").scalar()
        with self.assertRaises(ValueError):
            Reader(struct.pack("<I", 5000)).count(10)

    def test_integer_row_scales_and_bias(self):
        raw = struct.pack("<BIIb", 129, 2, 3, 0)
        raw += np.array([[1, -2, 127], [2, 3, -127]], dtype=np.int8).tobytes()
        raw += struct.pack("<I2d", 2, .5, .25)
        actual = matrix(Reader(raw), 0)
        np.testing.assert_array_equal(actual, [[.5, -1, 63.5], [.5, .75, -31.75]])

    def test_unknown_weights_rejected_before_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"unknown.traineddata"
            path.write_bytes(b"bad weights")
            with self.assertRaisesRegex(ValueError, "Unknown model"):
                read_model(path, "fast")

    def test_ctc_blank_repeated_letters_and_space(self):
        tess = TessModel(None, 3, {0: " ", 1: "a", 2: "b"}, "", "")
        sequence = [1, 1, 3, 1, 0, 0, 2, 3]
        probabilities = np.eye(4, dtype=np.float32)[sequence][None, :, :]
        self.assertEqual(tess.decode(probabilities), "aa b")

    def test_chinese_recoder_decodes_prefixes_and_blanks_inside_one_character(self):
        tess = TessModel(None, 9, {0:' ',1:'A',3:'',4:''}, '', '', 48,
                         {(0,):' ', (1,):'A', (3,5):'中', (3,5,6):'跑', (4,7):'文'})
        self.assertEqual(tess.decode_classes([3,3,9,5,1,9,1,0,4,9,7]), '中AA 文')
        self.assertEqual(tess.decode_classes([3,5,6,3,5]), '跑中')
        self.assertEqual(tess.decode_classes([4,6]), '\ufffd')

    def test_forward_reverse_and_vertical_gate_order_against_native_equations(self):
        # Three distinct directions exercise transpose/summary and reversal.
        # Small independent NumPy oracle uses native CIFO serialization and
        # clipped state, not the converter's gate reorder helper.
        rng = np.random.default_rng(7)
        data = rng.uniform(-1, 1, (36, 24, 1)).astype(np.float32)
        lstm = Layer("LSTM", 1, 2, "test", weights=[
            rng.normal(0, .3, (2, 4)).astype(np.float32) for _ in range(4)])
        core = ov.Core()
        for direction in ("forward", "reverse", "vertical"):
            with self.subTest(direction=direction):
                if direction == "reverse":
                    root = Layer("RTLReversed", 1, 2, "reverse", children=[lstm])
                    expected = native_lstm(data, lstm.weights, reverse=True)
                elif direction == "vertical":
                    summary = Layer("SummLSTM", 1, 2, "summary", weights=lstm.weights)
                    root = Layer("XYTranspose", 1, 2, "vertical", children=[summary])
                    expected = native_lstm(data.transpose(1, 0, 2), lstm.weights, summary=True)
                else:
                    root, expected = lstm, native_lstm(data, lstm.weights)
                compiled = core.compile_model(build_graph(TessModel(root, 0, {}, "", ""), 24), "CPU",
                    {"INFERENCE_NUM_THREADS": 1, "INFERENCE_PRECISION_HINT": "f32"})
                actual = compiled({0: data})[compiled.output(0)]
                np.testing.assert_allclose(actual, expected, atol=2e-6, rtol=2e-5)

    def test_strict_device_no_hidden_fallback(self):
        engine = object.__new__(LineRecognizer)
        engine.core = MagicMock()
        engine.core.compile_model.return_value.get_property.return_value = ["CPU"]
        engine.device, engine.tess = "GPU", None
        engine.compiled, engine.compilations = {}, []
        with patch("backend.experimental.line_recognizer.build_graph", return_value=object()):
            with self.assertRaisesRegex(RuntimeError, "Unexpected execution"):
                engine.compile(384)
        self.assertFalse(engine.compiled)

    def test_close_drops_compiled_requests_and_weights(self):
        engine = object.__new__(LineRecognizer)
        engine.compiled, engine.core, engine.tess = {384: (object(), object())}, object(), object()
        engine.close()
        self.assertEqual(engine.compiled, {})
        self.assertIsNone(engine.core)
        self.assertIsNone(engine.tess)
        engine.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            engine.compile(384)


if __name__ == "__main__":
    unittest.main()
