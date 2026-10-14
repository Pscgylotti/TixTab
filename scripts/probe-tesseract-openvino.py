"""Bounded, single-device development test; never silently falls back to CPU.

Run using the OpenVINO venv. Outputs stay under .cache/tesseract-openvino.
No weights are downloaded by this command. Each device runs in a subprocess
with a deadline and a private-memory limit, releasing its runtime on exit.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "experimental"))


def process_memory(process):
    if sys.platform != "win32":
        raise RuntimeError("This bounded hardware probe currently requires Windows")
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    query = ctypes.windll.psapi.GetProcessMemoryInfo
    query.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    query.restype = wintypes.BOOL
    if not query(wintypes.HANDLE(int(process._handle)), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return counters.PrivateUsage


def child(args, folder):
    import numpy as np
    import openvino as ov
    from PIL import Image, ImageDraw, ImageFont
    from tesseract_graph import read_model, build_graph, prepare_line
    path = ROOT / ("public/models/ocr/eng.traineddata" if args.variant == "fast"
                   else ".cache/tesseract-openvino/eng-best.traineddata")
    if args.variant == 'mixed-best':
        path = ROOT / 'public/models/tesseract-openvino-zh/mixed-best.traineddata'
    tess = read_model(path, args.variant)
    core = ov.Core()
    result = {"variant": args.variant, "device_requested": args.device,
              "openvino": ov.__version__, "width": args.width,
              "sha256": tess.sha256, "network": tess.spec,
              "device_name": core.get_property(args.device, "FULL_DEVICE_NAME")}
    (folder / "stage.txt").write_text("building", encoding="utf-8")
    graph = build_graph(tess, args.width)
    config = {"PERFORMANCE_HINT": "LATENCY"}
    if args.device == "CPU":
        config.update(INFERENCE_NUM_THREADS=2, NUM_STREAMS=1, INFERENCE_PRECISION_HINT="f32")
    if args.device == "GPU":
        config.update(INFERENCE_PRECISION_HINT="f32")
    (folder / "stage.txt").write_text("compiling", encoding="utf-8")
    start = time.perf_counter()
    compiled = core.compile_model(graph, args.device, config)
    result["compile_ms"] = round((time.perf_counter() - start) * 1000, 2)
    devices = compiled.get_property("EXECUTION_DEVICES")
    result["execution_devices"] = [devices] if isinstance(devices, str) else list(devices)
    if not all(device.split(".")[0] == args.device for device in result["execution_devices"]):
        raise RuntimeError("Unexpected execution device: " + str(result["execution_devices"]))
    (folder / "stage.txt").write_text("inferring", encoding="utf-8")
    samples = [None] if args.image else (["Flow"] if args.width < 192 else [
        "Thresholds", "Flow matching", "The quick brown fox"])
    font = ImageFont.truetype("C:/Windows/Fonts/times.ttf", 32)
    if args.variant == 'mixed-best' and not args.image:
        samples = ['中文 PDF 123', '混合 English', '识别 Test']
        font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 32)
    result["samples"] = []
    outputs = {}
    request = compiled.create_infer_request()
    for index, expected in enumerate(samples):
        if args.image:
            with Image.open(args.image) as original:
                if original.width*original.height > 4_000_000:
                    raise ValueError("Line image exceeds 4 million pixels")
                image = original.convert("RGB")
        else:
            left, top, right, bottom = font.getbbox(expected)
            image = Image.new("RGB", (right - left + 12, bottom - top + 12), "white")
            ImageDraw.Draw(image).text((6 - left, 6 - top), expected, font=font, fill="black")
        image.save(folder / f"sample-{index}.png")
        data = prepare_line(image, args.width, tess.input_height)
        start = time.perf_counter()
        probabilities = request.infer({0: data})[compiled.output(0)].copy()
        elapsed = (time.perf_counter() - start) * 1000
        valid_steps = (round(image.width * tess.input_height / image.height) + 6 + 2) // 3
        probabilities = probabilities[:, :valid_steps, :]
        outputs[str(index)] = probabilities
        result["samples"].append({"expected": expected, "recognized": tess.decode(probabilities),
                                  "ms": round(elapsed, 2)})
        image.close()
    np.savez(folder / "outputs.npz", **outputs)
    result["status"] = "ok"
    (folder / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("fast", "best", "mixed-best"), required=True)
    parser.add_argument("--device", choices=("CPU", "GPU", "NPU"), required=True)
    parser.add_argument("--width", type=int, default=384)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--memory-mib", type=int, default=1200)
    parser.add_argument("--image", help="Optional pre-segmented line image")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    folder = ROOT / ".cache" / "tesseract-openvino" / f"{args.variant}-{args.device.lower()}-{args.width}"
    folder.mkdir(parents=True, exist_ok=True)
    if args.child:
        try:
            child(args, folder)
        except Exception as error:
            (folder / "result.json").write_text(json.dumps({"status": "error",
                "variant": args.variant, "device_requested": args.device,
                "reason": str(error)[:8000]}, indent=2), encoding="utf-8")
            raise
        return
    if not 1 <= args.timeout <= 180 or not 256 <= args.memory_mib <= 1600:
        raise ValueError("Probe limits: timeout 1–180s; memory 256–1600 MiB")
    # Windows venv python.exe is a redirector that starts another process.
    # Run the real interpreter so deadlines/private-memory checks cover inference.
    command = [sys._base_executable, str(Path(__file__).resolve()), *sys.argv[1:], "--child"]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join([str(Path(sys.prefix) / "Lib" / "site-packages"),
                                               environment.get("PYTHONPATH", "")])
    result_path = folder / "result.json"
    result_path.unlink(missing_ok=True)
    with (folder / "log.txt").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW, env=environment)
        start, peak, reason = time.monotonic(), 0, None
        try:
            while process.poll() is None:
                peak = max(peak, process_memory(process))
                if peak > args.memory_mib * 1024 ** 2:
                    reason = "Stopped at private-memory limit"
                    break
                if time.monotonic() - start > args.timeout:
                    reason = "Stopped at compile/inference deadline"
                    break
                time.sleep(.1)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {
        "status": "stopped", "variant": args.variant, "device_requested": args.device,
        "reason": reason or "Child exited without a result"}
    result["peak_private_mib"] = round(peak / 1024 ** 2, 1)
    result["elapsed_s"] = round(time.monotonic() - start, 2)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    if result["status"] != "ok":
        sys.exit(1)


if __name__ == "__main__":
    main()
