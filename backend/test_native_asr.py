import json
import tempfile
import unittest
from unittest.mock import patch
import queue
import threading
import types
import numpy as np
from pathlib import Path
from native_asr import FRAME, Segmenter, model_directory, record


class SegmentTests(unittest.TestCase):
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
        with patch.dict('sys.modules', {'sounddevice': audio, 'webrtcvad': vad}):
            record(stop, lambda event, session, **values: events.append(event), {'id':'fixture','device':'CPU'}, segments)
        self.assertFalse(streams[0].active)
        self.assertEqual(len(segments.get_nowait()), 20 * FRAME * 2)
        self.assertIsNone(segments.get_nowait())
        self.assertNotIn('error', events)


if __name__ == '__main__':
    unittest.main()
