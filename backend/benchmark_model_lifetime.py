"""Real pinned Texo inference/release/reload on this Windows Intel device.

Reports process memory; it does not measure electrical power or pen latency.
No model or disk cache is removed.
"""
import base64
import ctypes
import io
import json
import time
import weakref
from pathlib import Path
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from backend import openvino_app as service


def memory():
    class Counters(ctypes.Structure):
        _fields_ = [('cb', ctypes.c_ulong), ('faults', ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ['peakWorkingSet', 'workingSet', 'peakPagedPool', 'pagedPool',
                                              'peakNonPagedPool', 'nonPagedPool', 'pagefile', 'peakPagefile', 'privateBytes']]
    counters = Counters(); counters.cb = ctypes.sizeof(counters)
    kernel, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return {'workingSetBytes': counters.workingSet, 'privateBytes': counters.privateBytes}


def main():
    image = Image.new('RGB', (384, 384), 'white'); draw = ImageDraw.Draw(image)
    draw.line([(150, 145), (235, 240)], fill='black', width=7)
    draw.line([(235, 145), (150, 240)], fill='black', width=7)
    encoded = io.BytesIO(); image.save(encoded, format='PNG')
    body = {'image': 'data:image/png;base64,' + base64.b64encode(encoded.getvalue()).decode(), 'device': 'NPU'}
    report = {'date': '2026-10-11', 'scope': 'Real Texo NPU encoder + CPU decoder, manual idle release and reload; no power measurement', 'cycles': []}
    with TestClient(service.app) as client:
        health = client.get('/health').json()
        assert 'release-idle' in health['capabilities']
        assert any(device['id'] == 'NPU' for device in health['devices'])
        report.update({'devices': health['devices'], 'openvinoVersion': health['version'], 'baseline': memory()})
        previous = None
        for _ in range(2):
            start = time.perf_counter()
            result = client.post('/recognize', json=body)
            assert result.status_code == 200, result.text
            data = result.json(); assert data['encoderDevice'] == 'NPU', data
            assert client.get('/health').json()['loaded']
            reference = weakref.ref(service._model)
            loaded = memory()
            released = client.post('/models/release', json={'action': 'release-idle'}, headers={'Origin': 'surfacetab://app'})
            assert released.status_code == 200 and released.json()['released'], released.text
            assert not client.get('/health').json()['loaded']
            assert service._idle_handle is None
            assert reference() is None, 'Model object is still retained after release'
            if previous is not None:
                assert data['latex'] == previous, 'Release/reload changed recognition output'
            previous = data['latex']
            report['cycles'].append({'latex': data['latex'], 'inferenceMs': data['timing']['totalMs'], 'cycleMs': (time.perf_counter()-start)*1000, 'loadedMemory': loaded, 'releasedMemory': memory(), 'modelObjectReleased': True, 'idleDeadlineCancelled': True})
    output = Path('docs/benchmarks/model-lifetime-20261011.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
