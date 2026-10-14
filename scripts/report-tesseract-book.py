"""Aggregate single-pass timings and show private, source-aligned NPU differences."""
import base64
import difflib
import hashlib
import html
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".cache/tesseract-openvino/book"
OUT = ROOT / "docs/performance"


def distance(a, b):
    row = list(range(len(b)+1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(current[-1]+1, row[j]+1, row[j-1]+(x != y)))
        row = current
    return row[-1]


def marked(a, b, side):
    text = a if side == "cpu" else b
    result = []
    for tag, i, j, k, l in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        piece = text[i:j] if side == "cpu" else text[k:l]
        if not piece:
            continue
        if tag == "equal":
            result.append(html.escape(piece))
        else:
            result.append('<mark>'+html.escape(piece).replace(' ', '␠')+'</mark>')
    return "".join(result)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    report = {"date": "2026-10-14", "kind": "single-pass-experimental-converted-english-tesseract",
              "pageRange": [index["first"], index["last"]], "pdfSha256": index["pdfSha256"],
              "blankLayoutPages": [p["page"] for p in index["pages"] if not p["lines"]],
              "inputSize": [1616, 2539], "cpuThreads": 2, "concurrency": 1,
              "layoutTotalMs": sum(p["layoutMs"] for p in index["pages"]),
              "extractTotalMs": sum(p["extractMs"] for p in index["pages"]),
              "layoutInitializationMs": index["layoutInitializationMs"],
              "gpuDriver": "32.0.101.6737", "npuDriver": "32.0.100.5540",
              "powerPlan": "Balanced (read only)", "energyMeasured": False, "results": [],
              "limitations": ["Approximate FP32 export, not native Tesseract bit parity",
                "CPU layout reused; pipeline totals are sums of measured stages, not full pipeline reruns",
                "Default NPU precision differs from CPU/GPU; text agreement is not ground-truth accuracy",
                "Original DAWG/beam decoder, Leptonica normalization and Fast activation rounding are absent",
                "Memory is sampled child-process private bytes; driver/shared GPU memory is excluded",
                "Initialization is observed, not guaranteed cold: driver compile cache uncontrolled"]}
    all_differences = []
    table = []
    for variant in ("fast", "best"):
        reference = json.loads((DATA / f"{variant}-cpu/result.json").read_text())
        cpu_text = [json.loads(l) for l in (DATA/f"{variant}-cpu/text-private.jsonl").read_text('utf-8').splitlines()]
        for device in ("cpu", "gpu", "npu"):
            result = json.loads((DATA / f"{variant}-{device}/result.json").read_text())
            assert result["status"] == "ok" and result["summary"]["lineCount"] == 1824
            assert [p["page"] for p in result["pages"]] == list(range(40, 101))
            texts = [json.loads(l) for l in (DATA/f"{variant}-{device}/text-private.jsonl").read_text('utf-8').splitlines()]
            same = sum(a["text"] == b["text"] for a, b in zip(cpu_text, texts))
            changed = [(a, b) for a, b in zip(cpu_text, texts) if a["text"] != b["text"]]
            edits = sum(distance(a["text"], b["text"]) for a,b in changed)
            if device == "npu":
                all_differences += [(variant, a, b) for a,b in changed]
            compact = {k:v for k,v in result.items() if k != "pages"}
            compact["pages"] = [{k:v for k,v in page.items() if k not in ("lineInferMs", "hashes")} for page in result["pages"]]
            compact["cpuOutputAgreement"] = {"equalLines": same, "totalLines": len(cpu_text),
                "percent": 100*same/len(cpu_text), "editDistance": edits,
                "cpuCharacters": sum(len(p["text"]) for p in cpu_text),
                "relativeEditRate": edits/max(1,sum(len(p["text"]) for p in cpu_text)),
                "isAccuracyMetric": False}
            report["results"].append(compact)
            s = result["summary"]
            table.append(f'| {variant.title()} | {device.upper()} | {s["recognitionMeanPageMs"]:.1f} | '
                f'{s["recognitionPagesPerSecond"]:.2f} | {s["pipelineComposedMeanPageMs"]:.1f} | '
                f'{s["pipelineComposedPagesPerSecond"]:.2f} | {result["initializationMs"]/1000:.2f} | {result["peakPrivateMiB"]:.1f} |')
    report["kernelSha256"] = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in (
        "backend/experimental/tesseract_graph.py", "backend/experimental/line_recognizer.py")}
    report['pipeline'] = []
    pipeline_table = []
    for variant in ('fast','best'):
        reference = json.loads((DATA/f'{variant}-cpu/result.json').read_text())
        for device in ('gpu','npu'):
            path = DATA/f'pipeline-{variant}-{device}-b4/result.json'
            if not path.exists():
                continue
            raw = json.loads(path.read_text())
            if raw.get('status') != 'ok':
                continue
            identical = total = 0
            for page in raw['pages']:
                ref = next(p for p in reference['pages'] if p['page'] == page['page'])
                assert page['lines'] == ref['lines']
                for a,b in zip(page['hashes'],ref['hashes']):
                    identical += a == b['text']; total += 1
            compact = {k:v for k,v in raw.items() if k != 'pages'}
            compact['cpuOutputAgreement'] = {'equalLines':identical,'totalLines':total,'isAccuracyMetric':False}
            report['pipeline'].append(compact)
            effective = '4' if device == 'gpu' else '4（短行）/ 1（长行）'
            pipeline_table.append(f'| {variant.title()} | {device.upper()} | {effective} | '
                f'{raw["meanPageMs"]:.1f} | {raw["pagesPerSecond"]:.2f} | '
                f'{raw["metrics"]["wallMs"]/1000:.2f} | {raw["jobPeakPrivateMiB"]:.1f} |')
    destination = OUT / "2026-10-14-tesseract-openvino-book.json"
    destination.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    lines = ['# English Fast / Best：Intel CPU、GPU、NPU 单次测试', '',
        '2026-10-14；PDF 文件页码 40–100，61 页，原始内嵌 1616×2539 灰度图片；固定 CPU 分行得到 1,824 行，4 页没有文字行。', '',
        '每组一次顺序运行，不重复取均值。表中平均为本批 61 页总时间 / 61。CPU 使用 2 线程；GPU/NPU 实际执行设备已核对，未使用 AUTO/HETERO 回退。', '',
        '| 模型 | 设备 | 识别 ms/页 | 识别 页/s | 合成流程 ms/页 | 合成流程 页/s | 加载/编译 s | 进程峰值 MiB |',
        '|---|---|---:|---:|---:|---:|---:|---:|', *table, '',
        '识别阶段包含读图、裁行、归一化、网络推理、贪心 CTC 解码及私有文本结果写入；不包含分行和初始编译。合成流程 = 本组识别时间 + 实测一次后复用的 CPU 分行/图片提取时间，不是各组重新执行完整分行的端到端测试。', '',
        f'共同 CPU 分行耗时 {report["layoutTotalMs"]/1000:.3f} s；提取图片 {report["extractTotalMs"]/1000:.3f} s。加载/编译另列，驱动缓存未清空，不能视为严格冷启动。进程峰值不包含驱动和共享显存。', '',
        'GPU 的两模型输出均与转换后的 CPU 输出 1,824/1,824 行相同。NPU 的差异见 JSON 中 cpuOutputAgreement；一致率衡量设备数值差异，不是识别正确率。', '',
        '这是开发中的英文识别网络迁移实验。Fast 权重反量化，省略原生激活量化；使用 Pillow 预处理、零卷积边界、标准 LSTM（未实现原生 ±100 状态裁剪）和贪心 CTC，尚未移植 Leptonica 行归一化和 DAWG/beam 解码。不能当作原生 Tesseract.js 整页性能或准确率，也没有改动应用默认后端。', '',
        '识别后端最多驻留三个宽度桶（384/768/1536），逐页读图、逐行释放裁图；每组在独立限时/限内存进程运行并退出。无常驻推理队列，未测能耗。', '',
        '复现入口：`scripts/benchmark-tesseract-book.py`、`scripts/tesseract-layout.mjs`、`scripts/report-tesseract-book.py`。原书图片与文字保留在本地 `.cache`，不加入公开报告。完整逐页数字见同名 JSON。', '',
        '## 独立 producer / consumer 与 batch', '',
        '下表为重新执行 CPU 分行的实际流水线 wall time，包含分行、图片加载、裁图、预处理、排队、设备推理和 CPU 字符串整理。初始模型/版面器加载及编译另列在 JSON 中，不含于表中。每组顺序一次运行。', '',
        '| 模型 | 设备 | 有效 batch | 实际流程 ms/页 | 页/s | 61 页总秒数 | 总子进程峰值 MiB |',
        '|---|---|---|---:|---:|---:|---:|', *pipeline_table, '',
        '全局最多 16 个规范化行输入（包括队列、等待分桶及设备正在处理的输入），同宽度组批，20 ms 超时或 EOF 刷出不足批；单个 CPU 版面器与单个 GPU/NPU 消费者并发。神经网络、Softmax 和类别选择在设备执行，CPU 只做分行、归一化、文字/坐标元数据整理。两种 GPU batch 输出仍与 CPU 逐行完全一致；NPU 差异与原单行对照相同。', '',
        '驱动 32.0.100.5540 的 NPU 多行长序列请求曾触发 DEVICE_LOST，已禁用；768/1536 宽度桶固定 batch=1，384 桶可 batch=4。原 TopK 的批量整数类别输出出现非法编号，改用设备端浮点 ReduceMax/Select/ReduceMin；每次检查输出有限、整数和字符范围，无效就停，不静默 CPU 回退。不能把驱动故障当作量化误差。', '',
        '一次 GPU 测试与另一任务编译重叠，已舍弃并单独重跑；表中不含被舍弃结果，也不对重复运行取平均。流水线总峰值包含 Python 与 Node 版面子进程，原表的单 Python 进程峰值不能直接与之等同比较。Windows Job Object 限制整个进程树 1500 MiB 私有提交，截止/退出同时清理后代；不限制或统计驱动共享显存。', '',
        '流水线复现：`scripts/benchmark-tesseract-pipeline.py --variant fast --device GPU --batch 4`（使用 OpenVINO Python 环境）。这些仍是源码实验，尚未替换现有“解析位图”提供器或其线程选项。']
    destination.with_suffix('.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    # Favor prose differences for inspection, then include formula/punctuation.
    examples = []
    for variant in ('fast','best'):
        candidates = [item for item in all_differences if item[0] == variant]
        prose = [item for item in candidates if item[1]['text'].isascii() and len(item[1]['text']) > 60]
        examples.extend((prose + [i for i in candidates if i not in prose])[:12])
    cards = []
    for variant, a, b in examples:
        page = next(p for p in index['pages'] if p['page'] == a['page'])
        box = page['lines'][a['line']]['bbox']
        with Image.open(DATA / page['image']) as source:
            crop = source.crop((max(0,box['x0']-8),max(0,box['y0']-8),
                                min(source.width,box['x1']+8),min(source.height,box['y1']+8)))
            buffer = io.BytesIO(); crop.save(buffer, format='PNG'); crop.close()
        image = base64.b64encode(buffer.getvalue()).decode()
        cards.append(f'<article><h2>{variant.title()} · PDF {a["page"]} · line {a["line"]+1}</h2>'
            f'<img loading="lazy" src="data:image/png;base64,{image}" alt="Original scan line">'
            f'<p class="cpu"><b>CPU</b> {marked(a["text"],b["text"],"cpu")}</p>'
            f'<p class="npu"><b>NPU</b> {marked(a["text"],b["text"],"npu")}</p></article>')
    document = '''<!doctype html><meta charset="utf-8"><title>NPU differences</title>
<style>body{background:#141922;color:#e5eaf3;font:16px/1.6 system-ui;margin:28px auto;max-width:1300px;padding:0 20px}
article{background:#202936;border:1px solid #38485f;border-radius:12px;padding:18px;margin:16px 0}h2{font-size:17px;margin:0 0 12px}
img{max-width:100%;height:auto;background:white}p{white-space:pre-wrap;overflow-wrap:anywhere}b{display:inline-block;width:48px}
mark{padding:2px;color:inherit;border-radius:3px}.cpu mark{background:#853d46}.npu mark{background:#226b50}</style>
<h1>NPU 输出差异</h1><p>CPU 也是实验性转换后端，并非正确答案。红色/绿色仅标示两者不同；␠ 表示变化的空格。
Fast 221/1824 行不同，Best 66/1824 行不同。以下为各 12 个例子，附原始扫描行。</p>'''+''.join(cards)
    (DATA/'npu-differences.html').write_text(document, encoding='utf-8')
    selected_keys = [('fast',40,20),('fast',41,10),('best',47,11),('best',46,23)]
    selected = [next(item for item in all_differences if (item[0],item[1]['page'],item[1]['line']) == key)
                for key in selected_keys]
    preview = Image.new('RGB',(1440,940),'#141922')
    draw = ImageDraw.Draw(preview)
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',19)
    heading = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',23)
    draw.text((24,16),'原图 / CPU / NPU 对照（CPU 输出也不保证正确）',font=heading,fill='#e5eaf3')
    for card,(variant,a,b) in enumerate(selected):
        y = 66+card*214
        draw.rounded_rectangle((16,y,1424,y+202),radius=12,fill='#202936')
        draw.text((32,y+10),f'{variant.title()} · PDF {a["page"]} · line {a["line"]+1}',font=heading,fill='#c6d4ea')
        page = next(p for p in index['pages'] if p['page'] == a['page'])
        box = page['lines'][a['line']]['bbox']
        with Image.open(DATA/page['image']) as source:
            with source.crop((max(0,box['x0']-8),max(0,box['y0']-8),min(source.width,box['x1']+8),min(source.height,box['y1']+8))) as crop:
                crop.thumbnail((1360,64))
                preview.paste(crop.convert('RGB'),(32,y+48))
        for side,text,row_y in [('cpu',a['text'],y+124),('npu',b['text'],y+160)]:
            draw.text((32,row_y),side.upper(),font=font,fill='#9db0cc')
            x = 90
            for tag,i,j,k,l in difflib.SequenceMatcher(None,a['text'],b['text'],autojunk=False).get_opcodes():
                part = text[i:j] if side == 'cpu' else text[k:l]
                if not part:
                    continue
                if tag != 'equal':
                    part = part.replace(' ','·')
                    length = draw.textlength(part,font=font)
                    draw.rectangle((x,row_y,x+length,row_y+28),fill='#853d46' if side == 'cpu' else '#226b50')
                draw.text((x,row_y),part,font=font,fill='#e5eaf3')
                x += draw.textlength(part,font=font)
    preview.save(DATA/'npu-differences-preview.png')
    print(json.dumps({'report':str(destination),'differences':str(DATA/'npu-differences.html'),
        'agreement':[(r['variant'],r['requestedDevice'],r['cpuOutputAgreement']) for r in report['results']]},indent=2))


if __name__ == '__main__':
    main()
