import threading
import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from backend import native_hymt as native, openvino_app as service

class HyMtTests(unittest.TestCase):
    def tearDown(self):
        service.cancel_idle_release();service.drop_model()

    def model(self):
        model=object.__new__(native.NativeHyMt)
        model.start=MagicMock();model.close=MagicMock();model.encoder_device='CPU'
        return model

    def test_official_prompt_token_budget_and_incomplete_results(self):
        model=self.model();calls=[]
        def request(route,body):
            calls.append((route,body))
            if route=='/apply-template':return {'prompt':'templated'}
            if route=='/tokenize':return {'tokens':[1,2,3]}
            return {'choices':[{'finish_reason':'stop','message':{'content':'translated'}}]}
        model.request=request
        self.assertEqual(model.translate('Hello','fr')['translation'],'translated')
        self.assertIn('French',calls[0][1]['messages'][0]['content'])
        self.assertEqual(calls[-1][1]['temperature'],.7)
        self.assertFalse(calls[-1][1]['cache_prompt'])
        model.request=lambda route,body: {'prompt':'x'} if route=='/apply-template' else {'tokens':list(range(8000))}
        with self.assertRaises(ValueError):model.translate('Hello','en')

    def test_cancellation_terminates_model_and_no_npu_mislabel(self):
        model=self.model();cancelled=threading.Event();cancelled.set()
        model.request=MagicMock(return_value={'prompt':'x','tokens':[]})
        with self.assertRaises(InterruptedError):model.translate('Hello','en',cancelled=cancelled)
        model.close.assert_called_once()
        ov=object.__new__(native.NativeHyMtOpenVino)
        with self.assertRaises(RuntimeError):ov.actual_device('NPU','using device OPENVINO0 (GGML_OPENVINO_DEVICE=CPU (selected)\noffloaded 33/33 layers')

    def test_api_switches_one_resident_model_and_release_closes_worker(self):
        first=MagicMock();first.translate.return_value={'translation':'one'}
        second=MagicMock();second.translate.return_value={'translation':'two'}
        with TestClient(service.app) as client,patch.object(service,'create_hymt',side_effect=[first,second]):
            self.assertEqual(client.post('/translate-hymt',json={'text':'a','target':'en','device':'NPU'}).status_code,400)
            self.assertEqual(client.post('/translate-hymt',json={'text':'a','target':'en'}).json()['translation'],'one')
            self.assertEqual(client.post('/translate-hymt',json={'text':'a','target':'en','backend':'openvino'}).json()['translation'],'two')
            first.close.assert_called_once()
            client.post('/models/release',json={'action':'release-idle'});second.close.assert_called_once()

if __name__=='__main__':unittest.main()
