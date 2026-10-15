"""Development-only export. C++ inference does not start Python.
Preserves the existing experimental graph/greedy decoder, not native DAWG.
"""
from pathlib import Path
import sys
import struct
import json
import hashlib
import openvino as ov
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/experimental'))
from tesseract_graph import read_model
from tesseract_batch_graph import build_batch_graph
graph_source = hashlib.sha256(b''.join((ROOT / 'backend/experimental' / name).read_bytes() for name in ['tesseract_graph.py', 'tesseract_batch_graph.py'])).hexdigest()
for variant, file in [('fast', ROOT / 'public/models/ocr/eng.traineddata'), ('best', ROOT / '.cache/tesseract-openvino/eng-best.traineddata')]:
    folder = ROOT / '.cache/native-ocr/npu-models' / variant
    folder.mkdir(parents=True, exist_ok=True)
    tess = read_model(file, variant)
    manifest = {'modelSha256': tess.sha256, 'graphSourceSha256': graph_source, 'variant': variant, 'openvino': ov.__version__, 'batch': 1, 'widths': [384,768,1536], 'experimental': True, 'decoder': 'greedy CTC, no DAWG'}
    try:
        cached = json.loads((folder / 'manifest.json').read_text(encoding='utf8'))
        if cached == manifest and all((folder / name).is_file() for name in ['codes.bin', '384.xml', '384.bin', '768.xml', '768.bin', '1536.xml', '1536.bin']):
            print(variant, 'unchanged IR retained for disk compilation cache')
            continue
    except (OSError, ValueError):
        pass
    for width in (384, 768, 1536):
        ov.save_model(build_batch_graph(tess, width, 1), folder / f'{width}.xml', compress_to_fp16=False)
    count = tess.blank + 1
    with (folder / 'codes.bin').open('wb') as output:
        output.write(struct.pack('<II', tess.blank, count))
        for code in range(count):
            value = tess.codes.get(code, '').encode('utf8')
            output.write(struct.pack('<I', len(value)))
            output.write(value)
    (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
    print(variant, folder)
