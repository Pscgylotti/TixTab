import asyncio
import unittest
import weakref

import numpy as np
import openvino as ov

from backend.experimental.tesseract_graph import Layer, TessModel, build_graph
from backend.experimental.tesseract_batch_graph import build_batch_graph
from backend.experimental.tesseract_pipeline import BatchRecognizer, run_pipeline


class FakeEngine:
    batch = 4

    async def infer(self, width, items):
        await asyncio.sleep(.001)
        return np.array([[item['line']] for item in items]), 1.0

    def decode(self, codes):
        return str(codes[0])


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_capacity_width_buckets_partial_flush_and_page_order(self):
        pages = [{"page":i} for i in range(5)]
        seen, tensors = {}, []
        async def layout(page):
            return [] if page['page'] == 2 else list(range(19))
        async def prepare(page,line):
            tensor = np.ones((2,2))
            tensors.append(weakref.ref(tensor))
            return {"tensor":tensor,"width":(384,768,1536)[line%3],"steps":1}
        async def sink(page,lines):
            seen[page['page']] = [l['text'] for l in lines]
        metrics = await asyncio.wait_for(run_pipeline(pages,layout,prepare,FakeEngine(),sink,capacity=4),5)
        self.assertLessEqual(metrics['maxInflightLines'],4)
        self.assertLessEqual(metrics['maxActivePages'],4)
        self.assertEqual(metrics['lines'],76)
        self.assertEqual(seen[2],[])
        for page in (0,1,3,4):
            self.assertEqual(seen[page],[str(i) for i in range(19)])
        self.assertTrue(all(ref() is None for ref in tensors))

    async def test_error_cancels_other_stages_and_drops_pixels(self):
        class Failure(FakeEngine):
            async def infer(self,width,items):
                raise RuntimeError('device lost')
        tensors = []
        async def layout(page):return list(range(100))
        async def prepare(page,line):
            tensor = np.ones((3,3))
            tensors.append(weakref.ref(tensor))
            return {"tensor":tensor,"width":384,"steps":1}
        async def sink(page,lines):self.fail('Unexpected incomplete page commit')
        with self.assertRaisesRegex(RuntimeError,'device lost'):
            await asyncio.wait_for(run_pipeline([{'page':1}],layout,prepare,Failure(),sink),5)
        import gc
        gc.collect()
        self.assertTrue(all(ref() is None for ref in tensors))

    async def test_cancellation_unblocks_full_queue(self):
        entered = asyncio.Event()
        class Blocked(FakeEngine):
            async def infer(self,width,items):
                entered.set()
                await asyncio.Future()
        async def layout(page):return list(range(100))
        async def prepare(page,line):return {'tensor':np.ones((1,1)),'width':384,'steps':1}
        async def sink(page,lines):pass
        job = asyncio.create_task(run_pipeline([{'page':1}],layout,prepare,Blocked(),sink))
        await entered.wait()
        job.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(job,1)

    async def test_known_npu_long_line_profile_avoids_failed_batch(self):
        engine = object.__new__(BatchRecognizer)
        engine.device, engine.batch = 'NPU',4
        engine.tess = TessModel(None, 0, {}, '', '')
        self.assertEqual(engine.batch_for_width(384),4)
        self.assertEqual(engine.batch_for_width(768),1)
        self.assertEqual(engine.batch_for_width(1536),1)
        engine.tess.input_height = 48
        self.assertEqual(engine.batch_for_width(384),1)
        engine.device = 'GPU'
        self.assertEqual(engine.batch_for_width(1536),4)


class BatchGraphTests(unittest.TestCase):
    def test_true_batch_matches_independent_lines_and_classify_on_device(self):
        rng = np.random.default_rng(23)
        vertical = Layer('SummLSTM',1,2,'vertical',weights=[rng.normal(0,.3,(2,4)).astype('f4') for _ in range(4)])
        horizontal = Layer('LSTM',2,3,'horizontal',weights=[rng.normal(0,.3,(3,6)).astype('f4') for _ in range(4)])
        head = Layer('Softmax',3,4,'head',weights=[rng.normal(0,.3,(4,4)).astype('f4')])
        root = Layer('Series',36,4,'test',children=[Layer('Maxpool',1,1,'pool',params=(3,3)),
            Layer('XYTranspose',1,2,'vertical',children=[vertical]),horizontal,head])
        tess = TessModel(root,3,{},'', '')
        data = rng.uniform(-1,1,(2,36,384,1)).astype('f4')
        core = ov.Core()
        config = {'INFERENCE_NUM_THREADS':1,'INFERENCE_PRECISION_HINT':'f32'}
        one = core.compile_model(build_graph(tess,384),'CPU',config)
        two_graph = build_batch_graph(tess,384,2)
        self.assertTrue(any(n.get_type_name() == 'ReduceMin' for n in two_graph.get_ordered_ops()))
        two = core.compile_model(two_graph,'CPU',config)
        output = two({0:data})[two.output(0)].reshape(2,128)
        for i in range(2):
            expected = one({0:data[i]})[one.output(0)].argmax(-1).reshape(-1)
            np.testing.assert_array_equal(output[i],expected)


if __name__ == '__main__':
    unittest.main()
