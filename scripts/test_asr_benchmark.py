"""Exercise the actual Windows collector independently of model inference."""
import ctypes
import importlib
import os
from pathlib import Path
import tempfile
import time
import unittest

benchmark = importlib.import_module('benchmark-asr')


@unittest.skipUnless(os.name == 'nt', 'Windows process counters')
class ExternalCollectorTests(unittest.TestCase):
    def test_gil_holding_native_call_cannot_block_samples_and_cpu_io_are_observed(self):
        collector = benchmark.Collector()
        collector.start()
        try:
            collector.phase = 'native-gil-held'
            before = collector.capture()
            # PyDLL deliberately retains the GIL across this blocking native call.
            sleep = ctypes.PyDLL('kernel32').Sleep
            sleep.argtypes, sleep.restype = [ctypes.c_ulong], None
            sleep(1200)
            after = collector.capture()
            collector.phase = 'cpu-and-io'
            first = collector.capture()
            deadline = time.perf_counter() + .8
            value = 0
            while time.perf_counter() < deadline:
                value += 1
            self.assertGreater(value, 0)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'known-bytes.bin'
                path.write_bytes(b'x' * 1024 * 1024)
                self.assertEqual(len(path.read_bytes()), 1024 * 1024)
            last = collector.capture()
        finally:
            collector.finish()
        during = [sample for sample in collector.samples if before['at'] <= sample['at'] <= after['at']]
        self.assertGreaterEqual(len(during), 6)
        self.assertLess(max(b['at'] - a['at'] for a, b in zip(during, during[1:])), 500)
        a, b = first['processes'][0], last['processes'][0]
        self.assertGreater(b['cpu']['cumulativeCPUUsage'] - a['cpu']['cumulativeCPUUsage'], .5)
        self.assertGreaterEqual(b['io']['writeTransferBytes'] - a['io']['writeTransferBytes'], 1024 * 1024)
        self.assertGreaterEqual(b['io']['readTransferBytes'] - a['io']['readTransferBytes'], 1024 * 1024)
        self.assertGreater(b['workingSetBytes'], 0)
        self.assertGreater(b['privateBytes'], 0)
        self.assertGreaterEqual(collector.collector_cpu, 0)


if __name__ == '__main__':
    unittest.main()
