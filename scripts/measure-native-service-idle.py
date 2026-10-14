"""One cold import snapshot, without starting a model, device scan, or HTTP server."""
import ctypes
import importlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
started = time.perf_counter()
importlib.import_module('backend.openvino_app')


class Memory(ctypes.Structure):
    _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong)] + [
        (name, ctypes.c_size_t) for name in (
            'PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
            'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage',
            'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]


memory = Memory()
memory.cb = ctypes.sizeof(memory)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GetCurrentProcess.restype = ctypes.c_void_p
psapi = ctypes.WinDLL('psapi', use_last_error=True)
psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Memory), ctypes.c_ulong]
if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(memory), memory.cb):
    raise ctypes.WinError(ctypes.get_last_error())
print(json.dumps({
    'kind': 'single-cold-service-import',
    'modelsLoaded': False,
    'deviceScan': False,
    'elapsedMs': round((time.perf_counter() - started) * 1000, 1),
    'workingSetBytes': memory.WorkingSetSize,
    'privateBytes': memory.PrivateUsage,
    'featureModules': [name for name in ('backend.native_texo', 'backend.native_opus',
                       'backend.native_ocr', 'tokenizers', 'cv2') if name in sys.modules],
}))
