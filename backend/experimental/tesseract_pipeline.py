"""Experimental CPU producer -> strict GPU/NPU batch consumer -> result sink.

The 16-slot bound covers queued, bucket-pending and device-in-flight normalized
lines together, not just the visible asyncio.Queue. Pixels are never collected
for the whole document. Layout/prepare callbacks run on CPU; all neural layers,
Softmax and class selection run in one GPU/NPU graph. Text assembly stays on CPU.
"""
import asyncio
from collections import defaultdict
import time

import numpy as np
import openvino as ov

try:
    from .tesseract_graph import read_model
    from .tesseract_batch_graph import build_batch_graph
except ImportError:
    from tesseract_graph import read_model
    from tesseract_batch_graph import build_batch_graph


class BatchRecognizer:
    def __init__(self, path, variant, device, batch):
        if device not in ("GPU", "NPU") or batch not in (1, 2, 4):
            raise ValueError("Strict GPU/NPU with batch 1/2/4 required")
        self.tess = read_model(path, variant)
        self.device, self.batch = device, batch
        self.core, self.compiled = ov.Core(), {}
        self.compilations, self.running, self.failure = [], None, None

    def batch_for_width(self, width):
        # Tested driver 32.0.100.5540 resets on long multi-row LSTM requests.
        # Keep inference on NPU, using its validated single-row path for long
        # lines; do not retry the failed multi-row shape or fall back to CPU.
        return 1 if self.device == "NPU" and (width > 384 or self.tess.input_height == 48) else self.batch

    def compile(self, width):
        if self.core is None:
            raise RuntimeError("Recognizer is closed")
        if width in self.compiled:
            return self.compiled[width]
        if len(self.compiled) >= 3:
            raise RuntimeError("Compiled-profile budget exceeded")
        effective_batch = self.batch_for_width(width)
        graph = build_batch_graph(self.tess, width, effective_batch)
        config = {"PERFORMANCE_HINT": "LATENCY"}
        if self.device == "GPU":
            config["INFERENCE_PRECISION_HINT"] = "f32"
        before = time.perf_counter()
        model = self.core.compile_model(graph, self.device, config)
        devices = model.get_property("EXECUTION_DEVICES")
        devices = [devices] if isinstance(devices, str) else list(devices)
        if not devices or any(d.split(".")[0] != self.device for d in devices):
            raise RuntimeError("Unexpected inference device: " + str(devices))
        self.compilations.append({"width": width, "batch": effective_batch, "requestedBatch": self.batch,
            "ms": (time.perf_counter()-before)*1000, "executionDevices": devices})
        self.compiled[width] = (model, model.create_infer_request())
        return self.compiled[width]

    async def infer(self, width, items):
        if self.failure:
            raise RuntimeError("Device profile disabled after failure: " + self.failure)
        effective_batch = self.batch_for_width(width)
        if self.running is not None or not 0 < len(items) <= effective_batch:
            raise RuntimeError("Invalid concurrent inference/batch")
        _model, request = self.compile(width)
        # Only the last/latency-flushed batch needs white placeholder rows.
        data = np.ones((effective_batch, self.tess.input_height, width, 1), np.float32)
        for i, item in enumerate(items):
            data[i] = item["tensor"]
        self.running = request
        before = time.perf_counter()
        try:
            # Let the runtime own/copy host input. Arbitrary NumPy addresses are
            # not guaranteed to satisfy accelerator zero-copy requirements.
            request.start_async({0: data}, share_inputs=False)
            waiting = asyncio.create_task(asyncio.to_thread(request.wait))
            await asyncio.shield(waiting)
            classes = request.get_output_tensor(0).data.reshape(effective_batch,width//3)[:len(items)].copy()
            if (not np.isfinite(classes).all() or np.any(classes < 0)
                    or np.any(classes > self.tess.blank) or np.any(classes != np.rint(classes))):
                raise RuntimeError("Invalid device classifier output; profile disabled")
            return classes, (time.perf_counter()-before)*1000
        except asyncio.CancelledError:
            try:
                request.cancel()
            except RuntimeError:
                pass
            try:
                await waiting
            except RuntimeError:
                pass  # Preserve cancellation after the runtime has released IO.
            raise
        except RuntimeError as error:
            self.failure = str(error)
            raise
        finally:
            self.running = None
            data = None

    def decode(self, codes):
        return self.tess.decode_classes(codes)

    def close(self):
        if self.running is not None:
            raise RuntimeError("Wait for inference cancellation before closing")
        self.compiled.clear()
        self.tess = None
        self.core = None


async def run_pipeline(pages, layout, prepare, engine, on_page, capacity=16, flush_ms=20):
    """Callbacks: async layout(page)->lines, async prepare(page,line)->tensor,
    async on_page(page, [{line, text, ...}]). The engine owns no CPU fallback.
    """
    batch = engine.batch
    if not 1 <= capacity <= 64 or capacity < batch or not 1 <= flush_ms <= 100:
        raise ValueError("Invalid queue/batch limits")
    slots, page_slots = asyncio.Semaphore(capacity), asyncio.Semaphore(capacity)
    inputs, outputs = asyncio.Queue(capacity), asyncio.Queue(capacity)
    states, pending = {}, defaultdict(list)
    metrics = {"capacity": capacity, "maxInflightLines": 0, "maxActivePages": 0,
               "batchCount": 0, "batchSizes": {}, "deviceTotalMs": 0.0,
               "pages": 0, "lines": 0, "producerMs": 0.0}
    inflight = 0

    async def producer():
        nonlocal inflight
        for page in pages:
            await page_slots.acquire()
            lines = await layout(page)
            key = page["page"]
            if key in states:
                raise ValueError("Duplicate page ID")
            states[key] = {"page": page, "count": len(lines), "results": {}, "start": time.perf_counter()}
            metrics["maxActivePages"] = max(metrics["maxActivePages"], len(states))
            if not lines:
                await outputs.put((key, None))
            for index, line in enumerate(lines):
                await slots.acquire()
                inflight += 1
                metrics["maxInflightLines"] = max(metrics["maxInflightLines"], inflight)
                before = time.perf_counter()
                item = await prepare(page, line)
                metrics["producerMs"] += (time.perf_counter()-before)*1000
                item.update(page=key, line=index, started=before)
                await inputs.put(item)
        await inputs.put(None)

    async def submit(width):
        nonlocal inflight
        items = pending.pop(width)
        try:
            codes, elapsed = await engine.infer(width, items)
            metrics["batchCount"] += 1
            metrics["batchSizes"][len(items)] = metrics["batchSizes"].get(len(items), 0)+1
            metrics["deviceTotalMs"] += elapsed
            for i, item in enumerate(items):
                item.pop("tensor", None)
                result = {"line": item["line"], "codes": codes[i, :item["steps"]],
                          "latencyMs": (time.perf_counter()-item["started"])*1000}
                await outputs.put((item["page"], result))
                inflight -= 1
                slots.release()
        finally:
            for item in items:
                item.pop("tensor",None)
            items.clear()

    async def consumer():
        while True:
            try:
                item = await asyncio.wait_for(inputs.get(), flush_ms/1000)
            except asyncio.TimeoutError:
                for width in list(pending):
                    await submit(width)
                continue
            if item is None:
                for width in list(pending):
                    await submit(width)
                await outputs.put(None)
                return
            width = item["width"]
            pending[width].append(item)
            profile_batch = getattr(engine,"batch_for_width",lambda _width:batch)(width)
            if len(pending[width]) == profile_batch:
                await submit(width)
            elif inflight == capacity and inputs.empty():
                # All capacity held by incomplete width buckets: flush to make
                # progress even when capacity is smaller than bucket_count*N.
                await submit(next(iter(pending)))

    async def sink():
        while True:
            packet = await outputs.get()
            if packet is None:
                if states:
                    raise RuntimeError("Incomplete page results")
                return
            key, result = packet
            state = states[key]
            if result is not None:
                result["text"] = engine.decode(result.pop("codes"))
                state["results"][result["line"]] = result
                metrics["lines"] += 1
            if len(state["results"]) == state["count"]:
                ordered = [state["results"][i] for i in range(state["count"])]
                await on_page(state["page"], ordered)
                del states[key]
                metrics["pages"] += 1
                page_slots.release()

    tasks = [asyncio.create_task(fn()) for fn in (producer, consumer, sink)]
    start = time.perf_counter()
    try:
        await asyncio.gather(*tasks)
        metrics["wallMs"] = (time.perf_counter()-start)*1000
        return metrics
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        pending.clear()
        states.clear()
        for queue in (inputs, outputs):
            while not queue.empty():
                queue.get_nowait()
