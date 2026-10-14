"""Kill-on-close, aggregate-memory-bounded Windows job for hardware probes.

Includes grandchildren such as the CPU layout Node worker. Do not use a venv
redirector as the child executable: launch sys._base_executable with PYTHONPATH.
"""
import ctypes
from ctypes import wintypes


class Basic(ctypes.Structure):
    _fields_ = [("ProcessTime", ctypes.c_int64), ("JobTime", ctypes.c_int64),
                ("Flags", wintypes.DWORD), ("MinWS", ctypes.c_size_t),
                ("MaxWS", ctypes.c_size_t), ("Processes", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("Priority", wintypes.DWORD),
                ("Scheduling", wintypes.DWORD)]


class IO(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ("Read", "Write", "Other", "ReadBytes", "WriteBytes", "OtherBytes")]


class Extended(ctypes.Structure):
    _fields_ = [("Basic", Basic), ("IO", IO), ("ProcessLimit", ctypes.c_size_t),
                ("JobLimit", ctypes.c_size_t), ("PeakProcess", ctypes.c_size_t),
                ("PeakJob", ctypes.c_size_t)]


class ProbeJob:
    def __init__(self, process, memory_mib=1500):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.Basic.Flags = 0x2000 | 0x200  # KILL_ON_JOB_CLOSE | JOB_MEMORY
        limits.JobLimit = memory_mib*1024**2
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle))):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def peak_mib(self):
        info = Extended()
        if not self.kernel.QueryInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return info.PeakJob/1024**2

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
