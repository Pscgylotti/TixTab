"""Resource, portable model and service controls; real-device checks are separate."""
from collections import OrderedDict
from pathlib import Path
import hashlib
import json
import os
import struct
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
import numpy as np
from fastapi.testclient import TestClient
from backend import openvino_app as service
from backend.native_opus import NativeOpus
from backend.opus_store import FILES, extract_archive, verify_files
from backend.opus_cache import trim_cache


class PortableModelTests(unittest.TestCase):
    def test_extracts_only_verified_direction_and_repairs_corrupt_cache(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'LOCALAPPDATA': temporary}):
            root=Path(temporary);data={name:('contents: '+name).encode() for name in FILES}
            manifest={'name':'opus-en-zh','revision':'abc123','files':[{'file':name,'size':len(value),'sha256':hashlib.sha256(value).hexdigest()} for name,value in data.items()]}
            data['manifest.json']=json.dumps(manifest).encode();header={'files':{}};offset=0
            for name,value in data.items():
                entry=header
                parts=('dist/models/opus-en-zh/'+name).split('/')
                for part in parts[:-1]:entry=entry['files'].setdefault(part,{'files':{}})
                entry['files'][parts[-1]]={'size':len(value),'offset':str(offset)};offset+=len(value)
            encoded=json.dumps(header).encode();archive=root/'app.asar'
            archive.write_bytes(struct.pack('<4I',4,len(encoded)+8,len(encoded)+4,len(encoded))+encoded+b''.join(data.values()))
            folder=extract_archive(archive,'en-zh');verify_files(folder,'en-zh')
            (folder/FILES[0]).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'checksum'):verify_files(folder,'en-zh')
            self.assertEqual(extract_archive(archive,'en-zh'),folder)
            self.assertEqual((folder/FILES[0]).read_bytes(),data[FILES[0]])
            with self.assertRaisesRegex(ValueError,'direction'):verify_files(folder,'zh-en')

    def test_compiled_cache_prunes_oldest_only_in_own_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);cache=root/'compiled';cache.mkdir();outside=root/'weights.onnx';outside.write_bytes(b'weights')
            old=cache/'old.blob';new=cache/'new.blob';old.write_bytes(b'x'*20);new.write_bytes(b'y'*30)
            os.utime(old,(1,1));os.utime(new,(2,2))
            old.chmod(stat.S_IREAD)
            self.assertEqual(trim_cache(cache,30),30)
            self.assertFalse(old.exists());self.assertTrue(new.exists());self.assertEqual(outside.read_bytes(),b'weights')


class EngineControlTests(unittest.TestCase):
    def model(self):
        model=object.__new__(NativeOpus);model.core=MagicMock();model.core.available_devices=['CPU','GPU','NPU']
        model.folder=Path('unused');model.encoders=OrderedDict();model.encoder_device='';model.failures={};model.retry_after={};model.cache=None
        return model

    def test_failed_npu_cools_down_and_gpu_nonfinite_falls_back_to_cpu(self):
        model=self.model();tried=[]
        def compile_graph(graph,device,config):
            tried.append(device)
            if device=='NPU':raise RuntimeError('driver unavailable')
            return lambda feeds:{0:np.full((1,feeds['input_ids'].shape[1],512),np.nan if device=='GPU' else 0,np.float32)}
        model.core.compile_model.side_effect=compile_graph
        with patch('backend.native_opus.weight_only_encoder_matmuls'):
            model.encode([1,2,0],'AUTO',None,time.monotonic()+10)
            self.assertEqual(tried,['NPU','GPU','CPU']);self.assertEqual(model.encoder_device,'CPU')
            model.encode([1,2,0],'AUTO',None,time.monotonic()+10);self.assertEqual(tried,['NPU','GPU','CPU'])

    def test_encoder_profiles_are_bounded_and_precancel_does_not_compile(self):
        model=self.model();model.core.compile_model.side_effect=lambda graph,device,config:lambda feeds:{0:np.zeros((1,feeds['input_ids'].shape[1],512),np.float32)}
        with patch('backend.native_opus.weight_only_encoder_matmuls'):
            for length in (9,31,97):model.encode([1]*length,'NPU',None,time.monotonic()+10)
            self.assertEqual(list(model.encoders),[('NPU',32),('NPU',128)])
            cancelled=threading.Event();cancelled.set()
            with self.assertRaises(InterruptedError):model.encode([1]*251,'NPU',cancelled,time.monotonic()+10)
            self.assertEqual(model.core.compile_model.call_count,3)
            with self.assertRaisesRegex(ValueError,'512'):model.encode([1]*513,'CPU',None,time.monotonic()+10)


class TranslationServiceTests(unittest.TestCase):
    def setUp(self):
        service._model=None;service._model_kind=None;self.client=TestClient(service.app)

    def tearDown(self):
        service._model=None;service._model_kind=None;self.client.close()

    def test_shared_model_eviction_direction_change_and_idle_release(self):
        with patch.object(service,'NativeOpus') as opus,patch.object(service,'NativeTexo') as texo:
            opus.return_value.translate.return_value={'translation':'translated'};texo.return_value.recognize.return_value={'latex':'x'}
            for direction in ['en-zh','en-zh','zh-en']:
                self.assertEqual(self.client.post('/translate',json={'text':'input','direction':direction}).status_code,200)
            self.assertEqual(opus.call_count,2)
            self.client.post('/recognize',json={'image':'test'});self.assertIs(service._model,texo.return_value)
            self.client.post('/translate',json={'text':'input','direction':'zh-en'});self.assertEqual(opus.call_count,3)
            service._last_used=time.monotonic()-service.IDLE_RELEASE_SECONDS-1;service.release_idle_model();self.assertIsNone(service._model)
        health=self.client.get('/health').json();self.assertIn('translate-experimental',health['capabilities']);self.assertFalse(health['loaded'])

    def test_busy_rejected_input_and_error_statuses(self):
        with patch.object(service,'NativeOpus') as constructor:
            self.assertEqual(self.client.post('/translate',json={'text':'a'*10001,'direction':'en-zh'}).status_code,422)
            constructor.assert_not_called()
            service._lock.acquire()
            try:self.assertEqual(self.client.post('/translate',json={'text':'x','direction':'en-zh'}).status_code,429)
            finally:service._lock.release()
            constructor.return_value.translate.side_effect=ValueError('smaller region')
            self.assertEqual(self.client.post('/translate',json={'text':'x','direction':'en-zh'}).status_code,400)
            constructor.return_value.translate.side_effect=TimeoutError()
            self.assertEqual(self.client.post('/translate',json={'text':'x','direction':'en-zh'}).status_code,504)
            constructor.return_value.translate.side_effect=RuntimeError('driver')
            self.assertEqual(self.client.post('/translate',json={'text':'x','direction':'en-zh'}).status_code,503);self.assertIsNone(service._model)

    def test_corrupt_model_is_unavailable_instead_of_rejected_user_input(self):
        with patch.object(service,'NativeOpus',side_effect=ValueError('OPUS model checksum mismatch')):
            response=self.client.post('/translate',json={'text':'The book','direction':'en-zh'})
            self.assertEqual(response.status_code,503);self.assertIsNone(service._model)


if __name__=='__main__':unittest.main()
