"""Small deterministic compatibility/timing samples, not an accuracy or wattage benchmark."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import base64
import io
import json
import platform
import openvino as ov
from native_texo import NativeTexo

font = ImageFont.truetype('C:/Windows/Fonts/times.ttf', 64)
small = ImageFont.truetype('C:/Windows/Fonts/times.ttf', 38)
samples = {}
for name in ('cross', 'sum', 'fraction'):
    image = Image.new('RGB', (480, 200), 'white'); draw = ImageDraw.Draw(image)
    if name == 'cross':
        draw.line((130, 40, 220, 140), fill='black', width=5); draw.line((220, 40, 130, 140), fill='black', width=5)
    elif name == 'sum':
        draw.text((30, 65), 'x', font=font, fill='black'); draw.text((60, 40), '2', font=small, fill='black')
        draw.text((100, 65), '+ y', font=font, fill='black'); draw.text((205, 40), '2', font=small, fill='black'); draw.text((240, 65), '= 1', font=font, fill='black')
    else:
        draw.text((120, 10), '2', font=font, fill='black'); draw.line((110, 95, 170, 95), fill='black', width=3); draw.text((120, 100), '3', font=font, fill='black')
    stream = io.BytesIO(); image.save(stream, format='PNG'); samples[name] = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()

model = NativeTexo()
report = {'runtime': ov.__version__, 'platform': platform.platform(), 'devices': model.devices(),
          'policy': 'AUTO: NPU -> GPU -> CPU; CPU decoder 2 threads; single request',
          'limitations': 'Three synthetic images. No power consumption or handwriting accuracy measurement. Compilation cache may already be warm.', 'runs': []}
for device in ('CPU', 'GPU', 'NPU', 'AUTO'):
    for name, image in samples.items():
        result = model.recognize(image, device)
        report['runs'].append({'sample': name, **result})
        print(name, device, result['encoderDevice'], result['latex'], round(result['timing']['totalMs'], 1), flush=True)
report['sameOutputsAcrossDevices'] = all(len({r['latex'] for r in report['runs'] if r['sample'] == name}) == 1 for name in samples)
destination = Path('docs/benchmarks/openvino-20261011.json'); destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
assert report['sameOutputsAcrossDevices'], 'Device outputs differ; review numerical compatibility'
