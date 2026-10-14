"""Fault-inject unavailable NPU enumeration, then run the real pinned CPU model."""
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))
from native_asr import SpeechModel, model_directory, read_wav


def main():
    output = ROOT / '.cache/asr-fallback-real-cpu.json'
    if output.exists():
        raise RuntimeError('Evidence is never overwritten.')
    cache = ROOT / '.cache/asr-fallback-isolated-cache'
    cache.mkdir(exist_ok=True)
    os.environ['LOCALAPPDATA'] = str(cache)
    manifest = json.loads((ROOT / 'backend/asr-manifest.json').read_text('utf-8'))
    directory = model_directory('whisper-small', Path(os.environ['APPDATA']) / 'surfacetab/model-library/v1',
                                ROOT / 'public/models', manifest)
    import openvino as ov
    import openvino_genai  # Initialize against the real runtime before fault injection.
    class CpuOnlyEnumeration(ov.Core):
        @property
        def available_devices(self):
            return ['CPU']
    with patch.object(ov, 'Core', CpuOnlyEnumeration):
        model = SpeechModel('whisper-small', directory, 'NPU', 'en-US')
    rows = []
    try:
        assert model.device == 'CPU'
        assert model.fallback == 'NPU'
        for language, file in [('en-US', 'en.wav'), ('zh-CN', 'zh.wav')]:
            text = model.transcribe(read_wav(ROOT / '.cache/asr-round3-samples' / file), language)
            assert len(text) > 3
            if language == 'en-US':
                assert 'library' in text.lower()
            rows.append({'language': language, 'text': text})
        output.write_text(json.dumps({'schema': 1, 'kind': 'asr-real-cpu-fallback',
            'requested': 'NPU', 'actual': model.device, 'fallback': model.fallback,
            'rows': rows, 'sources': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                for name in ['scripts/verify-asr-fallback.py', 'backend/native_asr.py', 'backend/asr-manifest.json']},
            'limitations': ['Device enumeration is fault-injected; decoding runs on the actual CPU backend.',
                'No claim of physical NPU failure, real microphone validation or energy measurement.']},
            ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print(json.dumps({'passed': True, 'requested': 'NPU', 'actual': model.device, 'utterances': len(rows)}))
    finally:
        model.close()


if __name__ == '__main__':
    main()
