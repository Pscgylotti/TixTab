"""Service contract/resource policy checks; real device benchmarks are separate."""
import time
import asyncio
import json
import unittest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from backend import openvino_app as service
from backend.native_texo import image_pixels, NativeTexo
from backend.cache_lease import CacheBusyError


class ServiceTests(unittest.TestCase):
    def setUp(self):
        service._model = None
        service.IDLE_RELEASE_SECONDS = 1800
        self.client = TestClient(service.app)

    def tearDown(self):
        service.cancel_idle_release()
        service._model = None
        self.client.close()

    def test_configurable_idle_policy_validates_and_never_unloads_busy_work(self):
        self.assertEqual(self.client.get('/health').json()['idleReleaseSeconds'], 1800)
        for value in [0, 29, 86401, 30.5, '90']:
            self.assertEqual(self.client.post('/models/config', json={'idleReleaseSeconds': value}).status_code, 422)
        self.assertEqual(self.client.post('/models/config', json={'idleReleaseSeconds': 60}, headers={'Origin':'https://foreign.example'}).status_code, 403)
        model=object();service._model=model;service._last_used=time.monotonic()-120
        service._lock.acquire()
        try:
            result=self.client.post('/models/config',json={'idleReleaseSeconds':60})
            self.assertEqual(result.status_code,200)
            self.assertIs(service._model,model)
        finally:
            service._lock.release()
        self.client.post('/models/config',json={'idleReleaseSeconds':60})
        self.assertIsNone(service._model)

    def test_manual_release_does_not_load_and_refuses_busy_or_foreign_origin(self):
        model = object(); service._model = model; service._model_kind = ('texo', None)
        service._lock.acquire()
        try:
            self.assertEqual(self.client.post('/models/release', json={'action': 'release-idle'}).status_code, 429)
            self.assertIs(service._model, model)
        finally:
            service._lock.release()
        self.assertEqual(self.client.post('/models/release', json={'action': 'release-idle'}, headers={'Origin': 'https://foreign.example'}).status_code, 403)
        self.assertIs(service._model, model)
        self.assertEqual(self.client.post('/models/release', json={'action': 'anything'}).status_code, 422)
        with patch.object(service, 'NativeTexo') as constructor:
            result = self.client.post('/models/release', json={'action': 'release-idle'}, headers={'Origin': 'surfacetab://app'})
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json()['released'])
            self.assertIsNone(service._model)
            self.assertIsNone(service._model_kind)
            self.assertFalse(self.client.post('/models/release', json={'action': 'release-idle'}).json()['released'])
            constructor.assert_not_called()

    def test_one_idle_deadline_replaces_the_previous_and_stops_after_release(self):
        async def check():
            service._model = object(); service._last_used = time.monotonic()
            service.schedule_idle_release(); first = service._idle_handle
            self.assertIsNotNone(first)
            service.schedule_idle_release(); second = service._idle_handle
            self.assertTrue(first.cancelled())
            self.assertIsNot(first, second)
            service.cancel_idle_release(); self.assertTrue(second.cancelled())
            service._last_used = time.monotonic() - service.IDLE_RELEASE_SECONDS - 1
            service.release_idle_model()
            self.assertIsNone(service._model)
            self.assertIsNone(service._idle_handle)
        asyncio.run(check())

    def test_real_idle_deadline_frees_model_without_a_periodic_poll(self):
        async def check():
            with patch.object(service, 'IDLE_RELEASE_SECONDS', .02):
                service._model = object(); service._model_kind = ('texo', None); service._last_used = time.monotonic()
                service.schedule_idle_release()
                await asyncio.sleep(.06)
                self.assertIsNone(service._model)
                self.assertIsNone(service._model_kind)
                self.assertIsNone(service._idle_handle)
        asyncio.run(check())

    def test_health_does_not_load_model_and_validates_host(self):
        with patch.object(service, 'NativeTexo') as constructor:
            response = self.client.get('/health', headers={'Origin': 'surfacetab://app'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['access-control-allow-origin'], 'surfacetab://app')
            self.assertFalse(response.json()['loaded'])
            self.assertIn('cache-lease-v1', response.json()['capabilities'])
            constructor.assert_not_called()
        self.assertEqual(self.client.get('/health', headers={'Host': 'foreign.example'}).status_code, 400)
        self.assertNotIn('access-control-allow-origin', self.client.get('/health', headers={'Origin': 'https://foreign.example'}).headers)

    def test_cache_maintenance_returns_busy_without_retaining_failed_model(self):
        with patch.object(service, 'NativeTexo', side_effect=CacheBusyError('fixture maintenance')):
            response = self.client.post('/recognize', json={'image': 'test'})
            self.assertEqual(response.status_code, 429)
            self.assertIsNone(service._model)
            self.assertIsNone(service._idle_handle)

    def test_request_device_default_and_busy(self):
        with patch.object(service, 'NativeTexo') as constructor:
            constructor.return_value.recognize.return_value = {'latex': 'x', 'encoderDevice': 'NPU'}
            self.assertEqual(self.client.post('/recognize', json={'image': 'test'}).json()['latex'], 'x')
            self.assertEqual(constructor.return_value.recognize.call_args.args, ('test', 'AUTO'))
        self.assertEqual(self.client.post('/recognize', json={'image': 'test', 'device': 'REMOTE'}).status_code, 422)
        service._lock.acquire()
        try:
            self.assertEqual(self.client.post('/recognize', json={'image': 'test'}).status_code, 429)
        finally:
            service._lock.release()

    def test_idle_release_does_not_release_busy_model(self):
        model = object(); service._model = model; service._last_used = time.monotonic() - service.IDLE_RELEASE_SECONDS - 1
        service._lock.acquire()
        try:
            service.release_idle_model(); self.assertIs(service._model, model)
        finally:
            service._lock.release()
        service.release_idle_model(); self.assertIsNone(service._model)

    def test_bad_input_does_not_poison_session_and_driver_failure_resets(self):
        with patch.object(service, 'NativeTexo') as constructor:
            constructor.return_value.recognize.side_effect = ValueError('empty drawing')
            self.assertEqual(self.client.post('/recognize', json={'image': 'test'}).status_code, 400)
            self.assertIsNotNone(service._model)
            constructor.return_value.recognize.side_effect = RuntimeError('driver failure')
            self.assertEqual(self.client.post('/recognize', json={'image': 'test'}).status_code, 503)
            self.assertIsNone(service._model)
        with self.assertRaises(ValueError):
            image_pixels('https://remote.example/image.png')

    def test_auto_order_and_failed_device_cooldown(self):
        model = object.__new__(NativeTexo)
        model.core = MagicMock(); model.core.available_devices = ['CPU', 'GPU', 'NPU']
        model.folder = __import__('pathlib').Path('unused')
        model.decoder = {}; model.encoder = None; model.encoder_device = ''; model.failures = {}; model.retry_after = {}
        tried = []
        def compile_model(graph, device, config):
            tried.append(device)
            if device == 'NPU':
                raise RuntimeError('unsupported driver')
            return object()
        model.core.compile_model.side_effect = compile_model
        model.prepare('AUTO'); self.assertEqual(tried, ['NPU', 'GPU']); self.assertEqual(model.encoder_device, 'GPU')
        model.prepare('AUTO'); self.assertEqual(tried, ['NPU', 'GPU'])

    def test_disconnected_request_stops_work_and_releases_lock(self):
        async def run_request():
            delivered = False; messages = []
            body = json.dumps({'image': 'test'}).encode()
            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': body, 'more_body': False}
                return {'type': 'http.disconnect'}
            async def send(message):
                messages.append(message)
            def recognize(image, device, cancelled):
                self.assertTrue(cancelled.wait(2), 'Disconnected native work was not cancelled')
                raise InterruptedError()
            with patch.object(service, 'NativeTexo') as constructor:
                constructor.return_value.recognize.side_effect = recognize
                await service.app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST', 'scheme': 'http', 'path': '/recognize', 'raw_path': b'/recognize', 'query_string': b'', 'headers': [(b'host', b'localhost'), (b'content-type', b'application/json')], 'server': ('127.0.0.1', 8766), 'client': ('127.0.0.1', 1234)}, receive, send)
            self.assertEqual(messages[0]['status'], 499)
            self.assertFalse(service._lock.locked())
        asyncio.run(run_request())


if __name__ == '__main__':
    unittest.main()
