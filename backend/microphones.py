"""Windows input identities shared with the offline Windows recognizer.

Enumerating endpoints never opens a microphone. Do not persist volatile device indexes.
"""
import base64
import ctypes as c


def enumerate_inputs():
    from ctypes import wintypes as w

    class Caps(c.Structure):
        _fields_ = [('mid', w.WORD), ('pid', w.WORD), ('version', w.DWORD),
                    ('name', w.WCHAR * 32), ('formats', w.DWORD),
                    ('channels', w.WORD), ('reserved', w.WORD)]

    dll = c.WinDLL('winmm')
    dll.waveInGetDevCapsW.argtypes = [c.c_size_t, c.POINTER(Caps), w.UINT]
    dll.waveInMessage.argtypes = [c.c_void_p, w.UINT, c.c_size_t, c.c_size_t]
    preferred, flags = w.DWORD(), w.DWORD()
    result = dll.waveInMessage(c.c_void_p(-1), 0x2015, c.addressof(preferred), c.addressof(flags))
    devices = []
    for index in range(dll.waveInGetNumDevs()):
        caps, length = Caps(), w.DWORD()
        if dll.waveInGetDevCapsW(index, c.byref(caps), c.sizeof(caps)):
            continue
        if dll.waveInMessage(c.c_void_p(index), 0x80D, c.addressof(length), 0) or not 0 < length.value <= 16384:
            continue
        interface = c.create_unicode_buffer((length.value + 1) // 2)
        if dll.waveInMessage(c.c_void_p(index), 0x80C, c.addressof(interface), length.value):
            continue
        identity = base64.b64encode(interface.value.lower().encode('utf-8')).decode('ascii')
        devices.append({'id': 'winmm:' + identity, 'name': caps.name,
                        'index': index, 'default': result == 0 and index == preferred.value})
    return devices


def resolve_input(sd, identity=''):
    devices = enumerate_inputs()
    chosen = next((d for d in devices if d['id'] == identity), None) if identity else next(
        (d for d in devices if d['default']), None)
    if chosen is None:
        raise ValueError('microphone-missing')
    host = next((h for h in sd.query_hostapis() if h['name'] == 'MME'), None)
    if host is None:
        raise ValueError('microphone-missing')
    inputs = [(i, sd.query_devices(i)) for i in host['devices'] if sd.query_devices(i)['max_input_channels'] > 0]
    # PortAudio's MME input list starts with WAVE_MAPPER, then native waveIn order.
    slot = chosen['index'] + 1
    if slot < len(inputs) and inputs[slot][1]['name'] == chosen['name']:
        return inputs[slot][0], chosen
    matches = [i for i, d in inputs if d['name'] == chosen['name']]
    if len(matches) != 1:
        raise ValueError('microphone-missing')
    return matches[0], chosen
