"""Verify managed-store selection with actual pinned weights, without inference."""
import json
import os
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import native_texo, opus_store, ocr_store, piper_store

root = Path(__file__).resolve().parent.parent
catalog = json.loads((root / 'electron/model-catalog.json').read_text('utf-8'))
with tempfile.TemporaryDirectory(prefix='surfacetab-managed-weights-') as temporary:
    managed = Path(temporary)
    for model in catalog['models']:
        if model['id'] in ('tesseract', 'piper-runtime'):
            continue
        base = managed / model['id'] / model['revision']
        for record in model['files']:
            destination = base / record['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.link(root / 'public/models' / record['path'], destination)
        for item in model['metadata']:
            (base / item['path']).write_text(json.dumps(item['data']), encoding='utf-8')
        (base / '.complete.json').write_text(json.dumps({'id': model['id'], 'revision': model['revision']}))
    os.environ['SURFACETAB_MANAGED_MODELS'] = temporary
    directories = [native_texo.model_directory(), opus_store.model_directory('en-zh'), opus_store.model_directory('zh-en'), ocr_store.model_directory(), piper_store.voice_directory('en_US-lessac-low'), piper_store.voice_directory('zh_CN-huayan-x_low')]
    assert all(directory.is_relative_to(managed) for directory in directories)
    print(json.dumps({'actualPinnedWeights': True, 'managedDirectoriesVerified': len(directories), 'inferencePerformed': False}))
