import asyncio
import base64
import gc
from io import BytesIO
import threading
import unittest
from unittest.mock import patch
import weakref

import numpy as np
from PIL import Image
from backend.native_tesseract import NativeTesseract
from backend.openvino_app import TesseractRequest


def image_data():
    with Image.new('L', (600, 100), 255) as image, BytesIO() as out:
        image.save(out, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()


class Engine:
    batch = 4
    def __init__(self):
        self.refs = []
        self.compilations = []
        self.closed = False
    def batch_for_width(self, width):
        return 1 if width > 384 else 4
    async def infer(self, width, items):
        self.refs.extend(weakref.ref(i['tensor']) for i in items)
        await asyncio.sleep(.001)
        return np.zeros((len(items), width//3)), 1
    def decode(self, codes):
        return 'English words'
    def close(self):
        self.closed = True


class NativeTesseractTests(unittest.TestCase):
    def native(self, engine):
        model = object.__new__(NativeTesseract)
        model.variant, model.engine = 'best', engine
        return model

    def test_queue_results_line_geometry_and_releasing_pixels(self):
        engine = Engine()
        model = self.native(engine)
        boxes = [[0,0,200,20], [0,25,600,45]] * 20
        result = model.recognize(image_data(), boxes, threading.Event())
        self.assertEqual(len(result['lines']), 40)
        self.assertEqual(result['lines'][0]['polygon'], [0,0,200,0,200,20,0,20])
        self.assertLessEqual(result['queue']['maxInflightLines'], 16)
        gc.collect()
        self.assertTrue(all(r() is None for r in engine.refs))
        model.close()
        self.assertTrue(engine.closed)
        self.assertIsNone(model.engine)

    def test_cancel_and_driver_failure_drain_queue(self):
        for failure in (False, True):
            cancelled = threading.Event()
            class Blocked(Engine):
                async def infer(self, width, items):
                    self.refs.extend(weakref.ref(i['tensor']) for i in items)
                    if failure:
                        raise RuntimeError('device lost')
                    cancelled.set()
                    await asyncio.Future()
            engine = Blocked()
            with self.assertRaises(RuntimeError if failure else InterruptedError):
                self.native(engine).recognize(image_data(), [[0,0,200,20]]*40, cancelled)
            gc.collect()
            self.assertTrue(all(r() is None for r in engine.refs))

    def test_schema_and_image_bounds_reject_unbounded_or_invalid_work(self):
        for kwargs in ({'batch':8}, {'variant':'other'}, {'boxes':[[0,0,1]]},
                       {'boxes':[[0,0,True,1]]}, {'boxes':[[0,0,1,1]]*2049}):
            with self.assertRaises(ValueError):
                TesseractRequest.model_validate({'image':image_data(), 'boxes':[], **kwargs})
        engine = Engine()
        with self.assertRaisesRegex(ValueError, 'outside image'):
            self.native(engine).recognize(image_data(), [[0,0,601,100]], threading.Event())
        self.assertFalse(engine.refs)

    def test_constructor_remains_strict_npu(self):
        with patch('backend.native_tesseract.model_path', return_value='fixed'):
            with patch('backend.native_tesseract.BatchRecognizer') as factory:
                model = NativeTesseract('best', 4)
                factory.assert_called_once_with('fixed', 'best', 'NPU', 4)
                model.close()


if __name__ == '__main__':
    unittest.main()
