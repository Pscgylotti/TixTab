"""Compare actual frozen thread policies on identical authored audio variants."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--samples', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Never overwrite existing quality evidence.')
    modules, sources = {}, {}
    for group in ['before', 'candidate']:
        frozen = getattr(args, group).resolve()
        try:
            frozen.relative_to((ROOT / '.cache').resolve())
        except ValueError:
            parser.error('Use frozen backends inside the workspace .cache directory.')
        manifest = json.loads((frozen / 'SOURCE-MANIFEST.json').read_text('utf-8'))
        for name, expected in manifest['files'].items():
            if digest(frozen / name) != expected:
                raise AssertionError('Frozen backend changed: ' + name)
        sources[group] = manifest
        spec = importlib.util.spec_from_file_location('asr_policy_' + group, frozen / 'backend/native_asr.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules[group] = module
    a, b = sources['before']['files'], sources['candidate']['files']
    if [name for name in a if a[name] != b[name]] != ['backend/asr-ort.config']:
        raise AssertionError('Only thread policy may differ.')
    fixture = json.loads((args.samples / 'samples.json').read_text('utf-8-sig'))
    rows = []
    model_manifest = json.loads((args.candidate / 'backend/asr-manifest.json').read_text('utf-8'))
    own_hash = digest(Path(__file__))
    for item in fixture['samples']:
        path = args.samples / item['file']
        if digest(path) != item['sha256']:
            raise AssertionError('Audio fixture changed.')
        samples = modules['before'].read_wav(path)
        random = np.random.default_rng(90210)
        rms = float(np.sqrt(np.mean(samples ** 2)))
        noise = random.normal(0, rms / (10 ** (12 / 20)), len(samples)).astype(np.float32)
        variants = {
            'clean': samples,
            'leading-trailing-silence': np.pad(samples, (8000, 8000)),
            'synthetic-noise-12dB': np.clip(samples + noise, -1, 1),
            'three-phrases': np.concatenate([samples, np.zeros(8000, np.float32), samples,
                                              np.zeros(8000, np.float32), samples]),
        }
        models = {}
        try:
            for group, module in modules.items():
                directory = module.model_directory('sensevoice-small',
                    Path(os.environ['APPDATA']) / 'surfacetab/model-library/v1', ROOT / 'public/models', model_manifest)
                models[group] = module.SpeechModel('sensevoice-small', directory, 'CPU', item['language'])
            for name, audio in variants.items():
                audio = np.asarray(audio, dtype=np.float32)
                results = {group: model.transcribe(audio, item['language']) for group, model in models.items()}
                if not results['before'] or results['before'] != results['candidate']:
                    raise AssertionError(json.dumps({'language': item['language'], 'variant': name, 'text': results}, ensure_ascii=False))
                row = {'language': item['language'], 'variant': name, 'audioSeconds': len(audio) / 16000,
                       'float32Sha256': hashlib.sha256(audio.tobytes()).hexdigest(), 'text': results, 'equal': True}
                rows.append(row)
                print(json.dumps({'language': row['language'], 'variant': name, 'equal': True}), flush=True)
        finally:
            for model in models.values():
                model.close()
    if digest(Path(__file__)) != own_hash:
        raise AssertionError('Quality harness changed during validation.')
    args.output.write_text(json.dumps({'schema': 1, 'kind': 'asr-thread-policy-quality',
        'createdUnixMs': round(time.time() * 1000), 'harnessSha256': own_hash, 'sources': sources,
        'model': next(model for model in model_manifest['models'] if model['id'] == 'sensevoice-small'),
        'fixture': fixture, 'rows': rows,
        'limitations': ['Authored TTS variants, not a real microphone or recognition accuracy benchmark.',
            'Strict output equality between policies; no resource/latency claim from this quality test.']},
        ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
