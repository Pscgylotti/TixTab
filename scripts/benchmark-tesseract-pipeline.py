"""Real CPU-layout/device-inference producer-consumer benchmark on prepared scans.

Unlike the earlier composed-stage comparison, wall time here includes fresh
CPU layout running concurrently with device inference. A Windows job bounds
aggregate child+layout-worker private memory and kills descendants on exit.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/experimental"))


async def owned_cpu_call(function, dispose=None):
    task = asyncio.create_task(asyncio.to_thread(function))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        result = await task
        if dispose:
            dispose(result)
        raise


async def run(args, folder):
    from PIL import Image
    from tesseract_graph import prepare_line
    from tesseract_pipeline import BatchRecognizer, run_pipeline
    data = ROOT / ".cache/tesseract-openvino/book"
    index = json.loads((data / "index.json").read_text(encoding="utf-8"))
    pages = index["pages"][:args.pages]
    model_path = ROOT / ("public/models/ocr/eng.traineddata" if args.variant == "fast"
                        else ".cache/tesseract-openvino/eng-best.traineddata")
    engine = BatchRecognizer(model_path, args.variant, args.device, args.batch)
    bridge, source = None, None
    records, layout_ms, node_rss = [], 0.0, 0
    start = time.perf_counter()
    try:
        if args.micro:
            engine.compile(384)
            path = ROOT / ".cache/tesseract-openvino/fast-cpu-384/sample-0.png"
            with Image.open(path) as image:
                tensor = prepare_line(image,384)
                steps = (round(image.width*36/image.height)+8)//3
            items = [{"tensor":tensor} for _ in range(args.batch)]
            codes, elapsed = await engine.infer(384,items)
            (folder / "result.json").write_text(json.dumps({"status":"ok","micro":True,
                "variant":args.variant,"device":args.device,"batch":args.batch,
                "ms":elapsed,"compilations":engine.compilations,
                "texts":[engine.decode(c[:steps]) for c in codes]},indent=2),encoding="utf-8")
            return
        (folder / "stage.txt").write_text("compiling", encoding="utf-8")
        for width in (384, 768, 1536):
            engine.compile(width)
        with (folder / "layout-stderr.log").open("wb") as log:
            bridge = await asyncio.create_subprocess_exec("node",
                str(ROOT / "scripts/tesseract-layout-worker.mjs"), str(data), cwd=ROOT,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW)

            async def receive():
                while True:
                    raw = await asyncio.wait_for(bridge.stdout.readline(), 60)
                    if not raw:
                        raise RuntimeError("CPU layout process exited")
                    if raw.startswith(b"TIXTAB_LAYOUT "):
                        return json.loads(raw[len(b"TIXTAB_LAYOUT "):])

            ready = await receive()
            if not ready.get("ready"):
                raise RuntimeError("CPU layout initialization failed")
            initialization_ms = (time.perf_counter()-start)*1000

            async def layout(page):
                nonlocal source, layout_ms, node_rss
                if source is not None:
                    source.close()
                    source = None
                (folder / "stage.txt").write_text(f'layout-{page["page"]}', encoding="utf-8")
                command = json.dumps({"id": page["page"], "image": page["image"]})+"\n"
                bridge.stdin.write(command.encode())
                await bridge.stdin.drain()
                result = await receive()
                if result.get("id") != page["page"]:
                    raise RuntimeError("CPU layout response out of sequence")
                layout_ms += result["ms"]
                node_rss = max(node_rss, result["rss"])
                def load():
                    image = Image.open(data / page["image"])
                    try:
                        image.load()
                        return image
                    except BaseException:
                        image.close()
                        raise
                source = await owned_cpu_call(load,lambda image:image.close())
                return result["lines"]

            async def prepare(_page, line):
                def normalize():
                    b = line["bbox"]
                    bounds = (max(0,b["x0"]-6),max(0,b["y0"]-6),
                              min(source.width,b["x1"]+6),min(source.height,b["y1"]+6))
                    with source.crop(bounds) as crop:
                        target = round(crop.width*36/crop.height)
                        width = next((w for w in (384,768,1536) if target+6 <= w), None)
                        if width is None:
                            raise ValueError("Line exceeds profile limit")
                        return {"tensor": prepare_line(crop,width), "width": width, "steps": (target+8)//3}
                return await owned_cpu_call(normalize)

            async def sink(page, lines):
                records.append({"page": page["page"], "lines": len(lines),
                    "hashes": [hashlib.sha256(l["text"].encode()).hexdigest() for l in lines],
                    "latencyMs": [l["latencyMs"] for l in lines]})
                (folder / "stage.txt").write_text(f'complete-{page["page"]}', encoding="utf-8")

            metrics = await run_pipeline(pages, layout, prepare, engine, sink,
                                         capacity=args.capacity, flush_ms=20)
        records.sort(key=lambda p:p["page"])
        result = {"status": "ok", "variant": args.variant, "device": args.device,
            "batch": args.batch, "metrics": metrics, "initializationMs": initialization_ms,
            "layoutTotalMs": layout_ms, "nodePeakRssMiB": node_rss/1024**2,
            "pagesPerSecond": len(pages)*1000/metrics["wallMs"],
            "meanPageMs": metrics["wallMs"]/len(pages),
            "linesPerSecond": metrics["lines"]*1000/metrics["wallMs"],
            "compilations": engine.compilations, "pages": records,
            "cpuNeuralInference": False, "deviceClassifier": True,
            "deviceArgmax": "floating-point-reduction",
            "experimentalApproximation": True, "pdfSha256": index["pdfSha256"]}
        (folder / "result.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    finally:
        if source is not None:
            source.close()
        if bridge is not None:
            if bridge.stdin:
                bridge.stdin.close()
            try:
                await asyncio.wait_for(bridge.wait(),5)
            except asyncio.TimeoutError:
                bridge.kill()
                await bridge.wait()
        engine.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("fast","best"), required=True)
    parser.add_argument("--device", choices=("GPU","NPU"), required=True)
    parser.add_argument("--batch", type=int, choices=(1,2,4), default=4)
    parser.add_argument("--capacity",type=int, default=16)
    parser.add_argument("--pages",type=int,default=61)
    parser.add_argument("--timeout",type=int,default=600)
    parser.add_argument("--micro",action="store_true",help="Small single-width device validation; no layout worker")
    parser.add_argument("--child",action="store_true",help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.pages <= 61 or not 1 <= args.timeout <= 900:
        raise ValueError("Invalid page/deadline limit")
    suffix = "-micro" if args.micro else ""
    folder = ROOT / f".cache/tesseract-openvino/book/pipeline-{args.variant}-{args.device.lower()}-b{args.batch}{suffix}"
    folder.mkdir(parents=True,exist_ok=True)
    if args.child:
        try:
            asyncio.run(run(args,folder))
        except Exception as error:
            (folder / "result.json").write_text(json.dumps({"status":"error","reason":str(error)[:6000]},indent=2),encoding="utf-8")
            raise
        return
    from windows_probe_job import ProbeJob
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join([str(Path(sys.prefix)/"Lib/site-packages"),environment.get("PYTHONPATH","")])
    result_path = folder / "result.json"
    result_path.unlink(missing_ok=True)
    (folder / "stage.txt").write_text("initializing",encoding="utf-8")
    command = [sys._base_executable,str(Path(__file__).resolve()),*sys.argv[1:],"--child"]
    with (folder / "log.txt").open("w",encoding="utf-8") as log:
        process = subprocess.Popen(command,stdout=log,stderr=log,env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        job, peak, reason = None, 0.0, None
        start, reported = time.monotonic(), 0.0
        try:
            job = ProbeJob(process,1500)
            while process.poll() is None:
                peak = max(peak,job.peak_mib())
                if time.monotonic()-start > args.timeout:
                    reason = "Stopped at deadline"
                    break
                if time.monotonic()-reported > 10:
                    stage = folder / "stage.txt"
                    print(json.dumps({"stage":stage.read_text() if stage.exists() else "initializing",
                        "jobPeakMiB":round(peak,1)}),flush=True)
                    reported = time.monotonic()
                time.sleep(.1)
        finally:
            if job is not None:
                peak = max(peak,job.peak_mib())
                job.close()  # Also terminates any orphaned layout grandchildren.
            if process.poll() is None:
                process.kill()
            process.wait()
    result = json.loads(result_path.read_text()) if result_path.exists() else {
        "status":"stopped","reason":reason or "Process exited/memory cap reached"}
    result["jobPeakPrivateMiB"] = round(peak,1)
    result["processElapsedS"] = round(time.monotonic()-start,2)
    result_path.write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k != "pages"},indent=2))
    if result["status"] != "ok":
        sys.exit(1)


if __name__ == '__main__':
    main()
