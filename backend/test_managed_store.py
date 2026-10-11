import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from backend.managed_store import managed_directory
from backend import native_texo, opus_store, ocr_store, piper_store


class ManagedStoreTests(unittest.TestCase):
    def test_only_completed_fixed_revision_is_returned(self):
        with tempfile.TemporaryDirectory(prefix='surfacetab-managed-') as temporary:
            folder = Path(temporary) / 'texo' / 'abc123'
            folder.mkdir(parents=True)
            with patch.dict(os.environ, {'SURFACETAB_MANAGED_MODELS': temporary}):
                self.assertIsNone(managed_directory('texo', 'abc123'))
                (folder / '.complete.json').write_text(json.dumps({'id': 'texo', 'revision': 'other'}))
                self.assertIsNone(managed_directory('texo', 'abc123'))
                (folder / '.complete.json').write_text(json.dumps({'id': 'texo', 'revision': 'abc123'}))
                self.assertEqual(managed_directory('texo', 'abc123', 'texo'), folder / 'texo')

    def test_all_four_native_stores_consume_managed_weights_and_keep_verification(self):
        cases = [
            (native_texo, lambda: native_texo.model_directory(), native_texo.FILES, 'texo', 'verify_files', {}),
            (opus_store, lambda: opus_store.model_directory('en-zh'), opus_store.FILES, 'opus-en-zh', 'verify_files', {}),
            (ocr_store, lambda: ocr_store.model_directory(), ocr_store.FILES, '', 'valid_file', {'name': 'ppocrv4', 'revision': 'rapidocr310', 'files': [{'file': n, 'sha256': h, 'size': 10} for n, h in zip(ocr_store.FILES, ocr_store.HASHES)]}),
            (piper_store, lambda: piper_store.voice_directory('en_US-lessac-low'), tuple(n for n, _ in piper_store.records('en_US-lessac-low')), '', 'valid_file', {}),
        ]
        for module, invoke, files, relative, check, manifest in cases:
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory(prefix='surfacetab-managed-') as temporary:
                base = Path(temporary)
                folder = base / relative
                for name in files:
                    destination = folder / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(b'prepared')
                (folder / 'manifest.json').write_text(json.dumps(manifest))
                with patch.object(module, 'managed_directory', return_value=folder), patch.object(module, check, return_value=True) as verify:
                    actual = invoke()
                    self.assertTrue(str(actual).startswith(str(base)))
                    self.assertTrue(verify.called, 'Managed weights must still be verified')


if __name__ == '__main__':
    unittest.main()
