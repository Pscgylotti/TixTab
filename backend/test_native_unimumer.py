import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch, MagicMock
from PIL import Image
from fastapi.testclient import TestClient
from backend import native_unimumer as native, openvino_app as service

class UnimumerTests(unittest.TestCase):
    def tearDown(self):
        service.cancel_idle_release(); service.drop_model()

    def test_checksum_and_size_reject_damaged_weights(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'fixture.gguf';p.write_bytes(b'weight')
            record={'bytes':6,'sha256':hashlib.sha256(b'weight').hexdigest()}
            native.verify(p,record)
            p.write_bytes(b'wrong!')
            with self.assertRaises(ValueError): native.verify(p,record)
            p.write_bytes(b'x')
            with self.assertRaises(ValueError): native.verify(p,record)

    def test_missing_downloads_do_not_launch_or_fetch_anything(self):
        with patch.object(native,'managed_directory',return_value=None),patch.object(native.subprocess,'Popen') as launch:
            with self.assertRaises(ValueError): native.NativeUnimumer()
            launch.assert_not_called()

    def test_invalid_images_never_start_the_model(self):
        model=object.__new__(native.NativeUnimumer);model.start=MagicMock()
        for image in ['https://example.test/image.png','data:image/png;base64,!!!','data:image/png;base64,aGVsbG8=']:
            with self.assertRaises(ValueError): model.recognize(image)
        model.start.assert_not_called()

    def test_cancellation_closes_owned_process_and_does_not_wait_for_inference(self):
        model=object.__new__(native.NativeUnimumer);model.start=MagicMock();model.close=MagicMock()
        event=threading.Event();event.set()
        model.request=lambda *_: {'choices':[{'finish_reason':'stop','message':{'content':'x'}}]}
        buffer=io.BytesIO();Image.new('RGB',(10,10),'white').save(buffer,format='PNG')
        with self.assertRaises(InterruptedError):model.recognize('data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode(),cancelled=event)
        model.close.assert_called_once()

    def test_service_shares_lane_and_closes_model_on_release_or_feature_switch(self):
        service.drop_model()
        q=MagicMock();q.recognize.return_value={'latex':'x','encoderDevice':'GPU'}
        texo=MagicMock();texo.recognize.return_value={'latex':'y','encoderDevice':'NPU'}
        with TestClient(service.app) as client,patch.object(service,'create_unimumer',return_value=q),patch.object(service,'NativeTexo',return_value=texo):
            self.assertEqual(client.post('/recognize-unimumer',json={'image':'test','device':'NPU'}).status_code,422)
            self.assertEqual(client.post('/recognize-unimumer',json={'image':'test','device':'GPU'}).json()['latex'],'x')
            self.assertEqual(client.post('/recognize',json={'image':'test'}).json()['latex'],'y');q.close.assert_called_once()
            self.assertEqual(client.post('/models/release',json={'action':'release-idle'}).status_code,200);texo.close.assert_called_once()
            service._lock.acquire()
            try:self.assertEqual(client.post('/recognize-unimumer',json={'image':'test'}).status_code,429)
            finally:service._lock.release()

    @unittest.skipUnless(os.name=='nt','Windows process ownership')
    def test_windows_job_terminates_only_the_owned_child(self):
        process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],creationflags=subprocess.CREATE_NO_WINDOW)
        job=None
        try:
            job=native.WindowsJob(process);self.assertIsNone(process.poll());job.close()
            process.wait(timeout=5);self.assertIsNotNone(process.returncode)
        finally:
            if job:job.close()
            if process.poll() is None:process.kill();process.wait(timeout=5)

if __name__=='__main__':unittest.main()
