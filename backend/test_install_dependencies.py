import io
import unittest
from pathlib import Path
from backend import install_dependencies as installer


class Child:
    def __init__(self, code):
        self.returncode = code
        self.stdout = io.StringIO('Downloading https://user:password@example.org/a?token=private\nAuthorization: Bearer secret123\n')

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -1


class InstallTests(unittest.TestCase):
    def test_fallback_uses_separate_https_indexes_and_pinned_requirements(self):
        calls, events = [], []
        def popen(args, **options):
            calls.append((args, options))
            return Child(1 if len(calls) == 1 else 0)
        self.assertTrue(installer.install(installer.ROOT / 'requirements-pdf.txt', popen=popen, report=lambda event, **data: events.append(dict(event=event, **data))))
        self.assertEqual([e['source'] for e in events if e['event'] == 'source'], ['pypi', 'tuna'])
        for args, options in calls:
            self.assertIn('--isolated', args)
            self.assertIn('--only-binary=:all:', args)
            self.assertNotIn('--extra-index-url', args)
            self.assertNotIn('--trusted-host', args)
            self.assertEqual(options['env']['PIP_CONFIG_FILE'], installer.os.devnull)
        logs = ' '.join(e.get('text','') for e in events)
        for secret in ['password','secret123','private','user:']:
            self.assertNotIn(secret, logs)

    def test_preferred_and_custom_source_validate_before_install(self):
        self.assertEqual(installer.preferred_sources('ustc')[0]['id'], 'ustc')
        self.assertEqual(installer.preferred_sources('custom','https://example.org/simple')[0]['id'], 'custom')
        for url in ['http://example.org/simple','https://name:pass@example.org/simple','https://example.org/?token=x','https://example.org/#key']:
            with self.assertRaises(ValueError): installer.preferred_sources('custom',url)
        with self.assertRaises(ValueError): installer.install(Path('C:/outside/requirements-pdf.txt'))

    def test_all_sources_fail_with_one_final_error(self):
        events = []
        self.assertFalse(installer.install(installer.ROOT / 'requirements-pdf.txt', popen=lambda *a, **k: Child(1), report=lambda event, **data: events.append(dict(event=event,**data))))
        self.assertEqual(len([e for e in events if e['event']=='source']),3)
        self.assertEqual(events[-1],dict(event='error',error='network'))


if __name__ == '__main__':
    unittest.main()
