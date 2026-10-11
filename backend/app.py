"""Optional loopback-only math OCR service. Models run locally; no cloud API."""
import base64
import io
import os
import threading
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

app = FastAPI(title="TixTab local formula OCR")
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "null"], allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
_model = None
_lock = threading.Lock()

class FormulaRequest(BaseModel):
    image: str = Field(max_length=4_000_000)

@app.get('/health')
def health():
    return {"ok": True, "loaded": _model is not None, "model": "Pix2Text mfr ONNX CPU"}

@app.post('/recognize')
def recognize(body: FormulaRequest):
    global _model
    if not body.image.startswith('data:image/png;base64,'):
        raise HTTPException(400, '只接受 PNG 公式图片')
    try:
        image = Image.open(io.BytesIO(base64.b64decode(body.image.split(',', 1)[1], validate=True)))
        if image.width * image.height > 4_000_000:
            raise HTTPException(400, '图片尺寸过大')
        image = image.convert('RGB')
    except (ValueError, UnidentifiedImageError, OSError):
        raise HTTPException(400, '图片数据无效')
    try:
        with _lock:
            if _model is None:
                from pix2text import LatexOCR
                options = {"model_name": "mfr", "model_backend": "onnx", "device": "cpu"}
                if os.environ.get('SURFACETAB_MODEL_DIR'):
                    options['model_dir'] = os.environ['SURFACETAB_MODEL_DIR']
                _model = LatexOCR(**options)
            out = _model.recognize(image)
        return {"latex": out['text'], "score": float(out.get('score', 0))}
    except Exception as error:
        raise HTTPException(503, f'本地公式模型不可用：{error}')
