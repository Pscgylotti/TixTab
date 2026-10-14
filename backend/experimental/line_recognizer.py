"""Bounded experimental recognizer. English, pre-segmented lines only.

Explicit CPU/GPU/NPU, one stream and at most three compiled width buckets.
No production provider registration, hidden fallback, downloads or idle tasks.
Use close()/a context manager to release the runtime. Hardware benchmarks run
this in a short-lived, monitored process to also release driver allocations.
"""
from collections import OrderedDict
import time

import numpy as np
import openvino as ov

try:
    from .tesseract_graph import build_graph, prepare_line, read_model
except ImportError:
    from tesseract_graph import build_graph, prepare_line, read_model


BUCKETS = (384, 768, 1536)


class LineRecognizer:
    def __init__(self, path, variant, device):
        if device not in ("CPU", "GPU", "NPU"):
            raise ValueError("Select an explicit CPU, GPU or NPU device")
        self.tess = read_model(path, variant)
        self.core = ov.Core()
        self.device = device
        self.compiled = OrderedDict()
        self.compilations = []

    def compile(self, width):
        if self.core is None:
            raise RuntimeError("Recognizer is closed")
        if width in self.compiled:
            return self.compiled[width]
        if len(self.compiled) >= 3:
            self.compiled.popitem(last=False)
        graph = build_graph(self.tess, width)
        config = {"PERFORMANCE_HINT": "LATENCY"}
        if self.device == "CPU":
            config.update(INFERENCE_NUM_THREADS=2, NUM_STREAMS=1, INFERENCE_PRECISION_HINT="f32")
        if self.device == "GPU":
            config.update(INFERENCE_PRECISION_HINT="f32")
        start = time.perf_counter()
        model = self.core.compile_model(graph, self.device, config)
        elapsed = (time.perf_counter() - start) * 1000
        devices = model.get_property("EXECUTION_DEVICES")
        devices = [devices] if isinstance(devices, str) else list(devices)
        if not devices or not all(d.split(".")[0] == self.device for d in devices):
            raise RuntimeError("Unexpected execution device: " + str(devices))
        self.compilations.append({"width": width, "ms": elapsed, "executionDevices": devices})
        request = model.create_infer_request()
        self.compiled[width] = (model, request)
        return model, request

    def recognize(self, image):
        start = time.perf_counter()
        target = round(image.width * self.tess.input_height / image.height)
        width = next((w for w in BUCKETS if target + 6 <= w), None)
        if width is None:
            raise ValueError("Line exceeds the experimental 1536-pixel width limit")
        model, request = self.compile(width)
        normalized = prepare_line(image, width, self.tess.input_height)
        prepared = time.perf_counter()
        probabilities = request.infer({0: normalized})[model.output(0)]
        inferred = time.perf_counter()
        valid_steps = (target + 8) // 3
        text = self.tess.decode(probabilities[:, :valid_steps, :])
        argmax = np.argmax(probabilities[:, :valid_steps, :], axis=-1).astype(np.uint8)
        end = time.perf_counter()
        return {"text": text, "argmax": argmax.tobytes(), "width": width,
                "prepareMs": (prepared-start)*1000, "inferMs": (inferred-prepared)*1000,
                "decodeMs": (end-inferred)*1000, "totalMs": (end-start)*1000}

    def close(self):
        self.compiled.clear()
        self.tess = None
        self.core = None

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.close()
