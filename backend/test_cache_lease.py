"""Real Windows sharing/cleanup integration, only in owned temporary fixtures."""
import gc
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

try:
    from .cache_lease import CacheBusyError, acquire_cache_lease, cache_user
except ImportError:
    from cache_lease import CacheBusyError, acquire_cache_lease, cache_user

HELPER = Path(__file__).resolve().parents[1] / 'electron' / 'cache-helper.ps1'


@unittest.skipUnless(os.name == 'nt', 'Windows FileShare integration')
class CacheLeaseTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='surfacetab-cache-test-')
        self.root = Path(self.fixture.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('surfacetab-cache-test-'))
        self.environment = patch.dict(os.environ, {'LOCALAPPDATA': str(self.root)})
        self.environment.start()
        self.base = self.root / 'SurfaceTab'
        self.blob = self.base / 'openvino-cache' / 'nested' / 'example.blob'
        self.blob.parent.mkdir(parents=True)
        self.blob.write_bytes(b'compiled fixture')
        self.sentinel = self.blob.parent / 'notes.txt'
        self.sentinel.write_text('keep unknown data')
        self.junction = None

    def tearDown(self):
        if self.junction is not None:
            self.junction.unlink() if self.junction.is_symlink() else os.rmdir(self.junction)
        if self.blob.exists():
            self.blob.chmod(0o666)
        self.environment.stop()
        self.fixture.cleanup()

    def helper(self, action='list', identifier='', token=''):
        result = subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
                                 '-ExecutionPolicy', 'Bypass', '-File', str(HELPER),
                                 '-Action', action, '-Id', identifier, '-Token', token],
                                capture_output=True, text=True, timeout=15, check=True)
        return json.loads(result.stdout.lstrip('\ufeff'))

    def row(self, identifier='texo-compiled'):
        return next(row for row in self.helper()['rows'] if row['id'] == identifier)

    def clear(self, token=None):
        return self.helper('clear', 'texo-compiled', token or self.row()['token'])

    def exclusive(self):
        # Constant script; fixture path is inherited via LOCALAPPDATA, never
        # concatenated into PowerShell code. A live handle gates the test.
        code = "$f=[IO.FileStream]::new((Join-Path $env:LOCALAPPDATA 'SurfaceTab/native-cache-use.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[Console]::WriteLine('ready');[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}"
        child = subprocess.Popen(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        self.addCleanup(lambda: child.communicate('\n', timeout=5) if child.poll() is None else None)
        return child

    def test_readonly_known_cache_only_and_snapshot(self):
        for category in ['model-library', 'openvino-runtime', 'documents']:
            folder = self.base / category
            folder.mkdir()
            (folder / 'example.blob').write_text('keep unrelated')
        override = self.root / 'custom-cache'
        override.mkdir()
        (override / 'example.blob').write_text('keep override')
        with patch.dict(os.environ, {'SURFACETAB_CACHE_DIR': str(override)}):
            row = self.row()
            self.assertEqual((row['files'], row['bytes'], row['preserved']), (1, 16, 1))
            self.blob.chmod(0o444)
            result = self.clear(row['token'])
        self.assertEqual((result['ok'], result['filesDeleted'], result['bytesDeleted']), (True, 1, 16))
        self.assertFalse(self.blob.exists())
        self.assertEqual(self.sentinel.read_text(), 'keep unknown data')
        for category in ['model-library', 'openvino-runtime', 'documents']:
            self.assertTrue((self.base / category / 'example.blob').exists())
        self.assertTrue((override / 'example.blob').exists())

    def test_changed_invalid_tokens_and_ids_preserve_cache(self):
        token = self.row()['token']
        self.blob.write_bytes(b'changed compiled fixture')
        self.assertEqual(self.clear(token)['error'], 'changed')
        self.assertEqual(self.helper('clear', '../openvino-cache', token)['error'], 'invalid')
        self.assertEqual(self.helper('clear', 'texo-compiled', 'wrong')['error'], 'invalid')
        self.assertTrue(self.blob.exists())

    def test_multiple_resident_models_block_actual_cleaner(self):
        one, two = acquire_cache_lease(), acquire_cache_lease()
        try:
            self.assertEqual(self.clear()['error'], 'busy')
            one.close()
            self.assertEqual(self.clear()['error'], 'busy')
        finally:
            one.close()
            two.close()
        self.assertTrue(self.clear()['ok'])

    def test_exclusive_cleaner_blocks_new_model_constructor(self):
        child = self.exclusive()
        with self.assertRaises(CacheBusyError):
            acquire_cache_lease()
        self.assertTrue(self.blob.exists())
        child.communicate('\n', timeout=5)
        with acquire_cache_lease():
            pass

    def test_model_residency_gc_and_failed_constructor_release(self):
        @cache_user
        class Model:
            def __init__(self, fail=False):
                if fail:
                    raise ValueError('fixture failure')
        model = Model()
        self.assertEqual(self.clear()['error'], 'busy')
        del model
        gc.collect()
        with self.assertRaises(ValueError):
            Model(True)
        self.assertTrue(self.clear()['ok'])

    def test_links_are_not_followed_or_removed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        sentinel = outside / 'example.blob'
        sentinel.write_text('outside sentinel')
        self.junction = self.blob.parent / 'linked'
        subprocess.run(['node', '-e', "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                        str(outside), str(self.junction)], check=True, timeout=5)
        row = self.row()
        self.assertEqual((row['files'], row['links']), (1, 1))
        self.assertEqual(self.clear(row['token'])['error'], 'unsafe')
        self.assertEqual(sentinel.read_text(), 'outside sentinel')
        self.assertTrue(self.blob.exists())

    def test_extracted_whitelist_preserves_other_models(self):
        root = self.base / 'native-models'
        known = root / ('a' * 40) / 'onnx' / 'encoder_model.onnx'
        known.parent.mkdir(parents=True)
        known.write_bytes(b'fixture weight')
        unknown = known.parent / 'personal-model.onnx'
        unknown.write_bytes(b'keep personal')
        row = self.row('extracted')
        self.assertEqual((row['files'], row['preserved']), (1, 1))
        self.assertTrue(self.helper('clear', 'extracted', row['token'])['ok'])
        self.assertFalse(known.exists())
        self.assertTrue(unknown.exists())


if __name__ == '__main__':
    unittest.main()
