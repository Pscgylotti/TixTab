using System.Runtime.InteropServices;

// Read Core Audio's existing capture peak meter. No second recorder, PCM buffer,
// polling thread or audio file is needed for the UI waveform.
internal sealed class AudioLevelMeter : IDisposable {
    IAudioMeterInformation? meter;
    AudioLevelMeter(IAudioMeterInformation value) { meter=value; }
    public bool Available => meter!=null;

    public static AudioLevelMeter? TryOpen(string? captureId=null) {
        IMMDeviceEnumerator? enumerator=null;
        IMMDeviceCollection? devices=null;
        IMMDevice? device=null;
        object? activated=null;
        try {
            enumerator=(IMMDeviceEnumerator)new MMDeviceEnumerator();
            if(string.IsNullOrEmpty(captureId)) enumerator.GetDefaultAudioEndpoint(1,2,out device);
            else {
                enumerator.EnumAudioEndpoints(1,1,out devices); // Capture, active endpoints only.
                devices.GetCount(out var count);
                for(uint i=0;i<count;i++) {
                    devices.Item(i,out var candidate);
                    try {
                        candidate.GetId(out var endpointId);
                        // WinRT returns an interface path containing the MMDevice endpoint ID.
                        if(captureId.Contains(endpointId,StringComparison.OrdinalIgnoreCase)) {
                            device=candidate; candidate=null!; break;
                        }
                    } finally { Release(candidate); }
                }
            }
            if(device==null) return null; // Never show another microphone's level.
            var iid=typeof(IAudioMeterInformation).GUID;
            device.Activate(ref iid,23,IntPtr.Zero,out activated);
            var result=new AudioLevelMeter((IAudioMeterInformation)activated);
            activated=null;
            return result;
        } catch { return null; } // Optional metering must not interrupt recognition.
        finally { Release(activated); Release(device); Release(devices); Release(enumerator); }
    }

    public int ReadLevel() {
        if(meter==null) return 0;
        try {
            meter.GetPeakValue(out var peak);
            return float.IsFinite(peak)?Math.Clamp((int)Math.Round(Math.Clamp(peak,0,1)*500),0,100):0;
        } catch { Dispose(); return 0; }
    }
    public void Dispose() { Release(meter); meter=null; }
    static void Release(object? value) {
        try { if(value!=null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
        catch { /* Device removal must not prevent remaining handles from being released. */ }
    }

    [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator {}
    [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        void EnumAudioEndpoints(int flow,uint mask,out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(int flow,int role,out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out IMMDevice device);
    }
    [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        void GetCount(out uint count);
        void Item(uint index,out IMMDevice device);
    }
    [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        void Activate(ref Guid iid,uint context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object instance);
        void OpenPropertyStore(uint access,out IntPtr store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);
    }
    [ComImport,Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation { void GetPeakValue(out float peak); }
}
