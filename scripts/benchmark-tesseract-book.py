"""One sequential 61-page run per model/device, with CPU layout reused.

Uses original embedded images, not screenshots or downscaled PDF previews.
Private source images/recognized text stay under .cache; report contains only
timings, hashes and counts. Fixed layout preparation is measured once and
reported separately; pipeline sums are explicitly stage-composed estimates.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "experimental"))


def prepare(args):
    import pymupdf
    if not args.pdf:
        raise ValueError("--prepare requires --pdf")
    path = Path(args.pdf).resolve()
    folder = ROOT / ".cache/tesseract-openvino/book"
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024*1024), b""):
            digest.update(chunk)
    index = {"first": args.first, "last": args.last, "pdfSha256": digest.hexdigest(), "pages": []}
    with pymupdf.open(path) as document:
        if not 1 <= args.first <= args.last <= len(document):
            raise ValueError("Invalid 1-based PDF page range")
        for number in range(args.first, args.last+1):
            start = time.perf_counter()
            page = document[number-1]
            images = page.get_images(full=True)
            if len(images) != 1 or page.rotation:
                raise ValueError("This benchmark expects one unrotated scanned image per page")
            image = document.extract_image(images[0][0])
            if image["smask"] or image["width"]*image["height"] > 16_000_000:
                raise ValueError("Unsupported scan image")
            name = f"page-{number:03d}.{image['ext']}"
            (folder / name).write_bytes(image["image"])
            index["pages"].append({"page": number, "image": name, "width": image["width"],
                "height": image["height"], "extractMs": (time.perf_counter()-start)*1000})
    (folder / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    subprocess.run(["node", str(ROOT / "scripts/tesseract-layout.mjs"), str(folder)],
                   cwd=ROOT, check=True, timeout=300)


def run(args, folder):
    import numpy as np
    import openvino as ov
    from PIL import Image
    from line_recognizer import LineRecognizer, BUCKETS
    inputs = ROOT / ".cache/tesseract-openvino/book"
    index = json.loads((inputs / "index.json").read_text(encoding="utf-8"))
    path = ROOT / ("public/models/ocr/eng.traineddata" if args.variant == "fast"
                   else ".cache/tesseract-openvino/eng-best.traineddata")
    result = {"variant": args.variant, "requestedDevice": args.device,
              "openvino": ov.__version__, "pageFirst": index["first"],
              "pageLast": index["last"], "pdfSha256": index["pdfSha256"],
              "cpuThreads": 2, "concurrency": 1, "pages": [],
              "pipelineTiming": "Measured shared extraction/layout + measured per-device processing; not a repeated full-layout run",
              "compileCacheState": "Driver cache uncontrolled; times are observed, not guaranteed cold",
              "experimentalApproximation": True}
    initial = time.perf_counter()
    with LineRecognizer(path, args.variant, args.device) as engine:
        result["modelSha256"] = engine.tess.sha256
        result["deviceName"] = engine.core.get_property(args.device, "FULL_DEVICE_NAME")
        (folder / "stage.txt").write_text("compiling", encoding="utf-8")
        for width in BUCKETS:
            engine.compile(width)
        result["initializationMs"] = (time.perf_counter() - initial) * 1000
        result["compilations"] = engine.compilations.copy()
        start = time.perf_counter()
        with (folder / "text-private.jsonl").open("w", encoding="utf-8") as texts:
            for item in index["pages"]:
                n = item["page"]
                (folder / "stage.txt").write_text(f"page-{n}", encoding="utf-8")
                before = time.perf_counter()
                infer_ms = prepare_ms = decode_ms = 0.0
                hashes, characters, line_times = [], 0, []
                with Image.open(inputs / item["image"]) as original:
                    original.load()
                    for line_index, line in enumerate(item["lines"]):
                        b = line["bbox"]
                        bounds = (max(0, b["x0"]-6), max(0, b["y0"]-6),
                                  min(original.width, b["x1"]+6), min(original.height, b["y1"]+6))
                        with original.crop(bounds) as crop:
                            recognized = engine.recognize(crop)
                        infer_ms += recognized["inferMs"]
                        prepare_ms += recognized["prepareMs"]
                        decode_ms += recognized["decodeMs"]
                        line_times.append(recognized["inferMs"])
                        characters += len(recognized["text"])
                        text_hash = hashlib.sha256(recognized["text"].encode()).hexdigest()
                        frame_hash = hashlib.sha256(recognized["argmax"]).hexdigest()
                        hashes.append({"text": text_hash, "frames": frame_hash})
                        texts.write(json.dumps({"page": n, "line": line_index,
                                                "text": recognized["text"]}, ensure_ascii=False)+"\n")
                        del recognized
                page_ms = (time.perf_counter() - before) * 1000
                record = {"page": n, "lines": len(item["lines"]), "characters": characters,
                          "recognitionMs": page_ms, "inferMs": infer_ms, "prepareMs": prepare_ms,
                          "decodeMs": decode_ms, "sharedLayoutMs": item["layoutMs"],
                          "sharedExtractMs": item["extractMs"],
                          "pipelineComposedMs": page_ms+item["layoutMs"]+item["extractMs"],
                          "lineInferMs": line_times, "hashes": hashes}
                result["pages"].append(record)
                print(json.dumps({"variant": args.variant, "device": args.device, "page": n,
                                  "ms": round(page_ms), "lines": record["lines"]}), flush=True)
        result["recognitionWallMs"] = (time.perf_counter()-start)*1000
    pages = result["pages"]
    line_ms = [m for p in pages for m in p["lineInferMs"]]
    recognition_ms = sum(p["recognitionMs"] for p in pages)
    infer_ms = sum(p["inferMs"] for p in pages)
    pipeline_ms = sum(p["pipelineComposedMs"] for p in pages)
    result["summary"] = {
        "pageCount": len(pages), "pagesWithLines": sum(bool(p["lines"]) for p in pages),
        "lineCount": len(line_ms), "inferenceTotalMs": infer_ms,
        "inferenceMsPerLine": float(np.mean(line_ms)),
        "inferenceLineP50Ms": float(np.percentile(line_ms, 50)),
        "inferenceLineP95Ms": float(np.percentile(line_ms, 95)),
        "inferenceLinesPerSecond": len(line_ms)*1000/infer_ms,
        "recognitionTotalMs": recognition_ms,
        "recognitionMeanPageMs": recognition_ms/len(pages),
        "recognitionPageP50Ms": float(np.percentile([p["recognitionMs"] for p in pages], 50)),
        "recognitionPageP95Ms": float(np.percentile([p["recognitionMs"] for p in pages], 95)),
        "recognitionPagesPerSecond": len(pages)*1000/recognition_ms,
        "pipelineComposedTotalMs": pipeline_ms,
        "pipelineComposedMeanPageMs": pipeline_ms/len(pages),
        "pipelineComposedPagesPerSecond": len(pages)*1000/pipeline_ms,
    }
    result["status"] = "ok"
    (folder / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--pdf")
    parser.add_argument("--first", type=int, default=40)
    parser.add_argument("--last", type=int, default=100)
    parser.add_argument("--variant", choices=("fast", "best"))
    parser.add_argument("--device", choices=("CPU", "GPU", "NPU"))
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--memory-mib", type=int, default=1100)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.prepare:
        prepare(args)
        return
    if not args.variant or not args.device:
        raise ValueError("Select --variant and --device, or use --prepare --pdf")
    folder = ROOT / ".cache/tesseract-openvino/book" / f"{args.variant}-{args.device.lower()}"
    folder.mkdir(parents=True, exist_ok=True)
    if args.child:
        try:
            run(args, folder)
        except Exception as error:
            (folder / "result.json").write_text(json.dumps({"status": "error",
                "reason": str(error)[:8000]}, indent=2), encoding="utf-8")
            raise
        return
    if not 1 <= args.timeout <= 900 or not 256 <= args.memory_mib <= 1600:
        raise ValueError("Invalid benchmark resource limits")
    spec = importlib.util.spec_from_file_location("probe", ROOT / "scripts/probe-tesseract-openvino.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join([str(Path(sys.prefix)/"Lib/site-packages"),
                                               environment.get("PYTHONPATH", "")])
    result_path = folder / "result.json"
    result_path.unlink(missing_ok=True)
    command = [sys._base_executable, str(Path(__file__).resolve()), *sys.argv[1:], "--child"]
    with (folder / "log.txt").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=log, stderr=log, env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        start, peak, reason, stage, reported = time.monotonic(), 0, None, "", 0.0
        try:
            while process.poll() is None:
                peak = max(peak, probe.process_memory(process))
                if peak > args.memory_mib*1024**2:
                    reason = "Stopped at private-memory limit"
                    break
                if time.monotonic()-start > args.timeout:
                    reason = "Stopped at deadline"
                    break
                status = folder / "stage.txt"
                stage = status.read_text(encoding="utf-8") if status.exists() else "initializing"
                if time.monotonic()-reported > 10:
                    print(json.dumps({"variant": args.variant, "device": args.device,
                                      "stage": stage, "privateMiB": round(peak/1024**2,1)}), flush=True)
                    reported = time.monotonic()
                time.sleep(.1)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {
        "status": "stopped", "reason": reason or "No result", "lastStage": stage}
    result["peakPrivateMiB"] = round(peak/1024**2, 1)
    result["processElapsedS"] = round(time.monotonic()-start, 2)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k not in ("pages",)}, indent=2))
    if result["status"] != "ok":
        sys.exit(1)


if __name__ == "__main__":
    main()
