"""Piper numerical boundaries, no truncation, cancellation and binary service."""
import io
import json
import threading
import time
import unittest
import wave
import weakref
from unittest.mock import patch, MagicMock
import numpy as np
import openvino as ov
from fastapi.testclient import TestClient
from backend.native_piper import NativePiper, CPU_CONFIG, pcm_wav, decoder_context, CONTEXT
from backend import openvino_app as service


class PiperTests(unittest.TestCase):
    def test_real_voices_stitching_retains_boundaries_and_every_sample(self):
        for voice in ('en_US-lessac-low','zh_CN-huayan-x_low'):
            p=NativePiper(voice)
            self.assertLessEqual(decoder_context(p.vocoder),CONTEXT)
            p.cancelled=None;p.deadline=time.monotonic()+90;p.compile_ms=0;p.stage_ms={'upstream':0,'vocoder':0};p.used=set()
            cpu=p.session('vocoder','CPU')
            rng=np.random.default_rng(17)
            # Run fixed-window stitching with float32 CPU to isolate slicing
            # from accelerator rounding; test the real two voice graphs.
            def window(latent,device):
                if device=='CPU':return cpu([latent])[0].ravel().copy()
                padded=np.zeros((1,p.channels,256),np.float32);padded[:,:,:latent.shape[2]]=latent
                return cpu([padded])[0].ravel().copy()
            p.decoder_window=window
            for frames in (65,255,300,580):
                latent=rng.normal(0,.3,(1,p.channels,frames)).astype(np.float32)
                expected=cpu([latent])[0].ravel().copy();actual=p.decode(latent,'NPU')
                self.assertEqual(len(actual),frames*256)
                np.testing.assert_allclose(actual,expected,atol=2e-6,rtol=2e-5)
            reference=weakref.ref(p);del p
            self.assertIsNone(reference())

    def test_split_cpu_matches_full_graph_with_zero_noise(self):
        p=NativePiper();p.cancelled=None;p.deadline=time.monotonic()+60;p.compile_ms=0;p.stage_ms={'upstream':0,'vocoder':0}
        from backend.piper_store import voice_directory
        full=p.core.compile_model(p.core.read_model(voice_directory(p.voice)/(p.voice+'.onnx')),'CPU',CPU_CONFIG)
        ids=np.array([[1,0,20,0,31,0,22,0,25,0,2]],np.int64)
        feeds={'input':ids,'input_lengths':np.array([ids.shape[1]],np.int64),'scales':np.array([0,1,0],np.float32)}
        expected=full(feeds)[0].ravel().copy()
        latent=p.infer('upstream','CPU',feeds);actual=p.decoder_window(latent,'CPU')
        np.testing.assert_allclose(actual,expected,atol=2e-5,rtol=1e-3)

    def test_invalid_input_precancel_and_pcm(self):
        p=NativePiper();cancel=threading.Event();cancel.set()
        with self.assertRaises(InterruptedError):p.synthesize([[1,0,20,0,2]],cancelled=cancel)
        self.assertEqual(p.sessions,{})
        for chunks in ([],[[1,0,999,2]],[[1,True,2]],[[1,0]*513+[2]]):
            with self.assertRaises(ValueError):p.synthesize(chunks)
        with self.assertRaises(RuntimeError):pcm_wav(np.array([float('nan')]),16000)
        with wave.open(io.BytesIO(pcm_wav(np.array([-2.,0,2.]),16000)),'rb') as reader:
            self.assertEqual((reader.getnframes(),reader.getframerate(),reader.getsampwidth()),(3,16000,2))

    def test_failed_accelerator_cools_down_and_falls_back_without_truncation(self):
        p=object.__new__(NativePiper);p.core=MagicMock();p.core.available_devices=['NPU','GPU','CPU']
        p.failures={};p.sessions={};p.used=set();p.encoder_device='CPU';calls=[]
        def window(latent,device):
            calls.append(device)
            if device=='NPU':raise RuntimeError('driver unavailable')
            return np.zeros(256*256 if device!='CPU' else latent.shape[2]*256,np.float32)
        p.decoder_window=window
        self.assertEqual(len(p.decode(np.zeros((1,192,400),np.float32),'AUTO')),400*256)
        self.assertIn('NPU',p.failures);calls.clear();p.decode(np.zeros((1,192,100),np.float32),'AUTO');self.assertNotIn('NPU',calls)

    def test_service_binary_contract_switch_busy_timeout_missing_and_validation(self):
        service._model=None;service._model_kind=None
        with TestClient(service.app) as client,patch.object(service,'create_piper') as factory,patch.object(service,'NativeTexo') as texo:
            factory.return_value.synthesize.return_value={'audio':b'RIFFtest','voice':'en_US-lessac-low','vocoderDevices':['NPU','CPU']}
            body={'voice':'en_US-lessac-low','chunks':[[1,0,20,0,2]],'device':'AUTO'}
            response=client.post('/synthesize',json=body,headers={'Origin':'surfacetab://app'})
            self.assertEqual(response.status_code,200);self.assertEqual(response.content,b'RIFFtest')
            self.assertEqual(json.loads(response.headers['X-SurfaceTab-Speech'])['voice'],body['voice'])
            self.assertIn('X-SurfaceTab-Speech',response.headers['access-control-expose-headers'])
            texo.return_value.recognize.return_value={'latex':'x'};client.post('/recognize',json={'image':'png'});self.assertIs(service._model,texo.return_value)
            service._lock.acquire()
            try:self.assertEqual(client.post('/synthesize',json=body).status_code,429)
            finally:service._lock.release()
            factory.return_value.synthesize.side_effect=TimeoutError();self.assertEqual(client.post('/synthesize',json=body).status_code,504)
            service._model=None;factory.side_effect=ValueError('missing model');self.assertEqual(client.post('/synthesize',json=body).status_code,503)
            for chunks in ([],[[1,True,2]],[[1]*1025],[[1,0,2]]*257):
                self.assertEqual(client.post('/synthesize',json={**body,'chunks':chunks}).status_code,422)
            self.assertEqual(client.post('/synthesize',json={**body,'chunks':[[1,0,2]*341]*65}).status_code,400)
        service._model=None;service._model_kind=None


if __name__=='__main__':unittest.main()
