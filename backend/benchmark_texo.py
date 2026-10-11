from PIL import Image,ImageDraw
import io,base64,json,time
from native_texo import NativeTexo
image=Image.new('RGB',(400,160),'white');d=ImageDraw.Draw(image);d.line((130,30,220,130),fill='black',width=5);d.line((220,30,130,130),fill='black',width=5);s=io.BytesIO();image.save(s,format='PNG');uri='data:image/png;base64,'+base64.b64encode(s.getvalue()).decode()
m=NativeTexo();print(m.devices(),flush=True)
for device in ['CPU','GPU','NPU']:
 for run in range(2):
  try:print(json.dumps({'run':run,**m.recognize(uri,device)},ensure_ascii=True),flush=True)
  except Exception as error:print(type(error).__name__,str(error),flush=True);break
