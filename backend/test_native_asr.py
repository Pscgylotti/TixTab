import json
import tempfile
import unittest
from unittest.mock import patch
import queue
import threading
import types
import numpy as np
from pathlib import Path
from native_asr import FRAME, Segmenter, SpeechModel, model_directory, record


class SegmentTests(unittest.TestCase):
    def test_sensevoice_uses_packaged_sleep_policy_without_changing_quality_parameters(self):
        options = []
        sherpa = types.SimpleNamespace(OfflineRecognizer=types.SimpleNamespace(
            from_sense_voice=lambda **kwargs: options.append(kwargs) or object()))
        with patch.dict('sys.modules', {'sherpa_onnx': sherpa}):
            model = SpeechModel('sensevoice-small', Path('fixture-model'), 'CPU', 'en-US')
            model.close()
        self.assertEqual(options[0]['num_threads'], 2)
        self.assertEqual(options[0]['language'], 'en')
        self.assertTrue(options[0]['use_itn'])
        provider, path = options[0]['provider'].split(':', 1)
        self.assertEqual(provider, 'cpu')
        policy = Path(path).read_text('utf-8')
        self.assertIn('SessionConfig.session.intra_op.allow_spinning=0', policy)
        self.assertIn('SessionConfig.session.inter_op.allow_spinning=0', policy)
        with patch.dict('sys.modules', {'sherpa_onnx': sherpa}), patch.object(Path, 'is_file', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'runtime'):
                SpeechModel('sensevoice-small', Path('fixture-model'), 'CPU')
        self.assertEqual(len(options), 1)  # Never start a fatal native load with a missing policy file.

    def test_microphone_identity_survives_portaudio_indexes_and_rejects_disconnected_device(self):
        from microphones import resolve_input
        devices = [{'id':'winmm:one','name':'Virtual mic','index':0,'default':True},
                   {'id':'winmm:two','name':'Surface mic','index':1,'default':False}]
        indexed = {40:{'name':'Mapper','max_input_channels':2},
                   12:{'name':'Virtual mic','max_input_channels':2},
                   5:{'name':'Surface mic','max_input_channels':2}}
        audio = types.SimpleNamespace(query_hostapis=lambda:[{'name':'MME','devices':[40,12,5]}],query_devices=lambda i:indexed[i])
        with patch('microphones.enumerate_inputs',return_value=devices):
            self.assertEqual(resolve_input(audio,'winmm:two')[0],5)
            self.assertEqual(resolve_input(audio)[0],12)
            with self.assertRaisesRegex(ValueError,'microphone-missing'):
                resolve_input(audio,'winmm:unplugged')
            devices[0]['default'],devices[1]['default']=False,True
            self.assertEqual(resolve_input(audio)[0],5)

    def test_whisper_keeps_complete_npu_compilation_cache_for_next_load(self):
        import os
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sizes = {'encoder.blob': 195522689, 'decoder.blob': 695970200}
            compilations = []
            real_stat = Path.stat
            def virtual_stat(path, *args, **kwargs):
                info = real_stat(path, *args, **kwargs)
                if path.name in sizes:
                    values = list(info)
                    values[6] = sizes[path.name]
                    return os.stat_result(values)
                return info
            def pipeline(directory, target, **options):
                cache = Path(options['CACHE_DIR'])
                if not all((cache / name).exists() for name in sizes):
                    compilations.append(target)
                for name in sizes:
                    (cache / name).write_bytes(b'compiled fixture')
                return object()
            ov = types.SimpleNamespace(__version__='fixture', Core=lambda: types.SimpleNamespace(available_devices=['NPU']))
            genai = types.SimpleNamespace(WhisperPipeline=pipeline)
            with patch.dict('os.environ', {'LOCALAPPDATA': temp}), patch.dict('sys.modules', {'openvino': ov, 'openvino_genai': genai}), patch('cache_lease.acquire_cache_lease'), patch.object(Path, 'stat', virtual_stat):
                for _ in range(2):
                    model = SpeechModel('whisper-small', root, 'NPU')
                    self.assertEqual(model.device, 'NPU')
                    self.assertTrue(all((model.cache / name).exists() for name in sizes))
                    model.close()
            self.assertEqual(compilations, ['NPU'])

    def test_silence_never_submits_inference(self):
        segmenter = Segmenter(lambda frame, rate: False)
        for _ in range(1000):
            self.assertIsNone(segmenter.push(b'\0' * FRAME * 2))
        self.assertIsNone(segmenter.flush())
        self.assertLessEqual(len(segmenter.pre), 10)

    def test_pause_includes_preroll_and_final_phrase_flushes_once(self):
        silent, spoken = b'\0' * FRAME * 2, b'\1' * FRAME * 2
        segmenter = Segmenter(lambda frame, rate: frame == spoken)
        for _ in range(10):
            segmenter.push(silent)
        for _ in range(20):
            self.assertIsNone(segmenter.push(spoken))
        for _ in range(23):
            self.assertIsNone(segmenter.push(silent))
        phrase = segmenter.push(silent)
        self.assertTrue(phrase.startswith(silent))
        self.assertEqual(phrase.count(spoken), 20)
        self.assertIsNone(segmenter.flush())
        for _ in range(10):
            segmenter.push(spoken)
        self.assertIsNotNone(segmenter.flush())
        self.assertIsNone(segmenter.flush())

    def test_long_utterances_remain_under_thirty_seconds(self):
        segmenter = Segmenter(lambda frame, rate: True)
        lengths = []
        for _ in range(2200):
            result = segmenter.push(b'\1' * FRAME * 2)
            if result:
                lengths.append(len(result))
        self.assertGreater(len(lengths), 2)
        self.assertTrue(all(n <= 666 * FRAME * 2 for n in lengths))

    def test_missing_or_corrupted_models_are_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = {'models': [{'id': 'sensevoice-small', 'revision': 'abc', 'files': [
                {'path': 'sensevoice-small/model.int8.onnx', 'bytes': 4, 'sha256': '0' * 64}]}]}
            with self.assertRaisesRegex(ValueError, 'model-missing'):
                model_directory('sensevoice-small', root, root, manifest)

            (root / 'sensevoice-small').mkdir()
            (root / 'sensevoice-small/model.int8.onnx').write_bytes(b'fake')
            with self.assertRaisesRegex(ValueError, 'model-missing'):
                model_directory('sensevoice-small', root, root, manifest)

    def test_stop_closes_capture_and_drains_all_queued_audio_before_final_phrase(self):
        stop = threading.Event()
        segments = queue.Queue()
        events = []
        streams = []

        class Input:
            active = True
            def __init__(self, **values):
                self.callback = values['callback']
                self.device = values['device']
                streams.append(self)
            def __enter__(self):
                for _ in range(20):
                    self.callback(np.full((FRAME, 1), .1, np.float32), FRAME, None,
                                  types.SimpleNamespace(input_overflow=False))
                stop.set()
                return self
            def abort(self):
                self.active = False
            def __exit__(self, *args):
                self.active = False

        audio = types.SimpleNamespace(InputStream=Input, check_input_settings=lambda **kw: None)
        vad = types.SimpleNamespace(Vad=lambda mode: types.SimpleNamespace(is_speech=lambda frame, rate: True))
        with patch.dict('sys.modules', {'sounddevice': audio, 'webrtcvad': vad}), patch('microphones.resolve_input', return_value=(3, {'name':'Surface mic'})):
            record(stop, lambda event, session, **values: events.append(event), {'id':'fixture','device':'CPU'}, segments)
        self.assertFalse(streams[0].active)
        self.assertEqual(streams[0].device,3)
        self.assertEqual(len(segments.get_nowait()), 20 * FRAME * 2)
        self.assertIsNone(segments.get_nowait())
        self.assertNotIn('error', events)


if __name__ == '__main__':
    unittest.main()
