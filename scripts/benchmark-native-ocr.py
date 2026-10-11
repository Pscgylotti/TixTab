"""Manual, real-device synthetic OCR benchmark. Not an accuracy or power claim."""
import base64
import gc
import json
import os
import statistics
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import openvino as ov
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from backend.native_ocr import NativeOcr

root=Path('.cache/ocr-benchmark');root.mkdir(parents=True,exist_ok=True)
os.environ['SURFACETAB_OCR_CACHE']=str(root/'runtime-cache')
font_path='C:/Windows/Fonts/msyh.ttc'
def fixture(name,lines,size=32,width=1000,rotate=False,degrade=False):
    image=Image.new('RGB',(width,max(120,50+len(lines)*(size+32))),'white');draw=ImageDraw.Draw(image)
    font=ImageFont.truetype(font_path,size)
    for i,line in enumerate(lines):draw.text((25,20+i*(size+32)),line,font=font,fill='#222222')
    if degrade:
        image=image.filter(ImageFilter.GaussianBlur(.65));pixels=np.array(image,dtype=np.float32)
        image=Image.fromarray(np.clip(pixels+np.random.default_rng(7).normal(0,5,pixels.shape),0,255).astype(np.uint8))
    if rotate:image=image.rotate(180)
    file=root/(name+'.png');image.save(file)
    return {'name':name,'expectedLines':lines,'size':image.size,'png':file,
            'image':'data:image/png;base64,'+base64.b64encode(file.read_bytes()).decode()}
fixtures=[
 fixture('mixed',['SurfaceTab OCR competitive English 12345','This is a book. Open the next page.','本地文字识别与低功耗模式','中英文混合 Surface Pro 2026','公式 x^2 + y^2 = 1']),
 fixture('word',['competitive'],width=300),
 fixture('english',['The diffusion coefficient depends on temperature.','The pressure is 101.325 kPa.'],width=1000),
 fixture('chinese',['本地模型支持中文与英文文字识别。','快速预览可以降低渲染负载。']),
 fixture('small',['Small text remains selectable. 1234567890'],size=16,width=700),
 fixture('numbers',['2026-10-11 15:30','0.12345 -98.76 100% 3.14159'],width=800),
 fixture('rotated',['Upside down text.','翻转页面文字识别'],rotate=True),
 fixture('degraded',['A scanned page with light blur.','轻度模糊扫描文字 12345'],degrade=True),
 fixture('narrow',['Surface','Pro','English'],width=250),
 fixture('math',['x^2 + y^2 = 1','E = mc^2'],width=600),
 fixture('long',['A long text line preserves all words: competitive SurfaceTab 12345.'],size=48,width=2500),
 fixture('blank',[],width=400)
]
core=ov.Core();report={'date':'2026-10-11','openvino':ov.__version__,'devices':[{ 'id':d,'name':core.get_property(d,'FULL_DEVICE_NAME')} for d in core.available_devices],
 'syntheticOnly':True,'powerMeasured':False,'font':font_path,'modelBytes':sum(p.stat().st_size for p in Path('public/models/ppocrv4').glob('*.onnx')),'results':[]}
for device in ['CPU','NPU','GPU']:
    model=NativeOcr();record={'requested':device,'cases':[]}
    for item in fixtures:
        result=model.recognize(item['image'],device)
        record['cases'].append({**{key:value for key,value in item.items() if key not in ('image','png')},**result})
        print(json.dumps({'device':device,'case':item['name'],'ms':round(result['timing']['totalMs'],2),'actual':result['devices']},ensure_ascii=True),flush=True)
    # Warm the exact mixed-region shapes again after the other case shapes.
    model.recognize(fixtures[0]['image'],device)
    warm=[model.recognize(fixtures[0]['image'],device)['timing']['totalMs'] for _ in range(8)]
    record['warmMixedMs']=warm;record['medianWarmMixedMs']=statistics.median(warm)
    record['failedProfiles']=model.failures;record['cacheBytes']=sum(p.stat().st_size for p in model.cache_dir.iterdir() if p.is_file())
    report['results'].append(record);del model;gc.collect()
destination=Path('docs/benchmarks/ocr-openvino-20261011.json');destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
print(json.dumps({'report':str(destination),'warmMixedMedianMs':{r['requested']:r['medianWarmMixedMs'] for r in report['results']}}),flush=True)
