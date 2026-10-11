"""OCR graph correctness, request lifecycle and bounded accelerator fallback."""
import base64
import io
import threading
import time
import unittest
import weakref
from collections import OrderedDict
from unittest.mock import MagicMock, patch
import numpy as np
import openvino as ov
from PIL import Image, ImageDraw, ImageFont
from fastapi.testclient import TestClient
from backend.native_ocr import NativeOcr, read_image, split_recognition, CPU_CONFIG
from backend import openvino_app as service


class OcrTests(unittest.TestCase):
    def test_wide_region_keeps_one_complete_line_across_detection_tiles(self):
        image=Image.new('RGB',(2500,150),'white')
        text='A long text line preserves all words: competitive SurfaceTab 12345.'
        ImageDraw.Draw(image).text((25,20),text,font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',48),fill='black')
        stream=io.BytesIO();image.save(stream,'PNG')
        model=NativeOcr();result=model.recognize('data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode(),'CPU')
        self.assertEqual(result['text'],text)
        cancelled=threading.Event();cancelled.set()
        with self.assertRaises(InterruptedError):model.recognize('unused','AUTO',cancelled=cancelled)
        reference=weakref.ref(model);del model
        self.assertIsNone(reference(), 'Idle release must not retain an owner/session cycle')

    def test_png_bounds_and_transparency_are_checked_before_inference(self):
        stream=io.BytesIO();Image.new('RGBA',(4,4),(0,0,0,0)).save(stream,'PNG')
        image='data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()
        self.assertTrue((read_image(image)==255).all())
        for value in ['https://remote/image.png','data:image/png;base64,!!!']:
            with self.assertRaises(ValueError):read_image(value)
        stream=io.BytesIO();Image.new('L',(2001,2000),255).save(stream,'PNG')
        with self.assertRaisesRegex(ValueError,'pixels'):read_image('data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode())
        stream=io.BytesIO();Image.new('L',(8192,1),255).save(stream,'PNG')
        with self.assertRaisesRegex(ValueError,'narrow'):read_image('data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode())

    def test_split_head_preserves_cpu_probabilities_and_dynamic_layout(self):
        core=ov.Core();model=core.read_model('public/models/ppocrv4/ch_PP-OCRv4_rec_mobile.onnx')
        backbone,head=split_recognition(model)
        head=core.compile_model(head,'CPU',CPU_CONFIG)
        rng=np.random.default_rng(7)
        for width in (320,640):
            full=model.clone();full.reshape([1,3,48,width]);part=backbone.clone();part.reshape([1,3,48,width])
            pixels=rng.normal(0,.2,(1,3,48,width)).astype(np.float32)
            expected=core.compile_model(full,'CPU',CPU_CONFIG)([pixels])[0].copy()
            feature=core.compile_model(part,'CPU',CPU_CONFIG)([pixels])[0].copy()
            actual=head([feature])[0].copy()
            np.testing.assert_allclose(actual,expected,rtol=1e-4,atol=2e-6)
            np.testing.assert_array_equal(actual.argmax(2),expected.argmax(2))

    def model(self):
        model=object.__new__(NativeOcr);model.core=MagicMock();model.core.available_devices=['CPU','GPU','NPU']
        model.requested='AUTO';model.cancelled=None;model.deadline=time.monotonic()+20
        model.failed={};model.failures={};model.compiled=OrderedDict();model.stage_ms={s:0 for s in ('det','rec','cls')};model.used={s:set() for s in ('det','rec','cls')}
        model.encoder_device='';return model

    def test_failed_accelerators_cool_down_and_nonfinite_falls_back(self):
        model=self.model();tried=[]
        def compile(stage,device,shape):
            tried.append(device)
            if device=='NPU':raise RuntimeError('incompatible driver')
            return lambda feeds:{0:np.full((1,1,768,768),np.nan if device=='GPU' else .5,np.float32)}
        model.compile=compile;pixels=np.zeros((1,3,384,768),np.float32)
        self.assertTrue(np.isfinite(model.infer('det',pixels)).all());self.assertEqual(tried,['NPU','GPU','CPU'])
        model.infer('det',pixels);self.assertEqual(tried,['NPU','GPU','CPU','CPU'])

    def test_long_lines_use_cpu_without_truncation_and_precancel_starts_nothing(self):
        model=self.model();tried=[]
        def compile(stage,device,shape):
            tried.append((device,shape));return lambda feeds:{0:np.zeros((1,shape[3]//8,6625),np.float32)}
        model.compile=compile;model.infer('rec',np.zeros((1,3,48,1500),np.float32))
        self.assertEqual(tried,[('CPU',[1,3,48,1500])])
        with self.assertRaises(ValueError):model.infer('rec',np.zeros((1,3,48,4097),np.float32))
        model.cancelled=threading.Event();model.cancelled.set()
        with self.assertRaises(InterruptedError):model.infer('det',np.zeros((1,3,32,32),np.float32))
        self.assertEqual(len(tried),1)

    def test_shared_service_switch_busy_timeout_and_optional_dependency_failure(self):
        service._model=None;service._model_kind=None
        with TestClient(service.app) as client,patch.object(service,'create_ocr') as factory,patch.object(service,'NativeTexo') as texo:
            factory.return_value.recognize.return_value={'text':'text'};texo.return_value.recognize.return_value={'latex':'x'}
            self.assertEqual(client.post('/ocr',json={'image':'png'}).json()['text'],'text')
            self.assertEqual(factory.return_value.recognize.call_args.args,('png','AUTO'))
            client.post('/recognize',json={'image':'png'});self.assertIs(service._model,texo.return_value)
            service._lock.acquire()
            try:self.assertEqual(client.post('/ocr',json={'image':'png'}).status_code,429)
            finally:service._lock.release()
            factory.return_value.recognize.side_effect=TimeoutError();self.assertEqual(client.post('/ocr',json={'image':'png'}).status_code,504)
            service._model=None;factory.side_effect=ImportError('OCR extra not installed')
            self.assertEqual(client.post('/ocr',json={'image':'png'}).status_code,503)
        service._model=None;service._model_kind=None


if __name__=='__main__':unittest.main()
