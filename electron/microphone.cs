// Windows input discovery and bounded PCM stream for System.Speech.
// Endpoint interface IDs are shared with backend/microphones.py.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class TixTabMicrophone {
  public string id { get; set; }
  public string name { get; set; }
  public bool isDefault { get; set; }
  public uint index;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Caps {
    public ushort mid, pid; public uint version;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
    public uint formats; public ushort channels, reserved;
  }
  [StructLayout(LayoutKind.Sequential, Pack=2)]
  struct Format {
    public ushort tag, channels; public uint rate, bytes;
    public ushort align, bits, extra;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Header {
    public IntPtr data; public uint length, recorded; public UIntPtr user;
    public uint flags, loops; public IntPtr next; public UIntPtr reserved;
  }
  [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] static extern uint waveInGetDevCapsW(UIntPtr id, out Caps caps, uint size);
  [DllImport("winmm.dll")] static extern uint waveInMessage(IntPtr id, uint message, IntPtr first, IntPtr second);
  [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr handle, uint device, ref Format format, IntPtr callback, IntPtr instance, uint flags);
  [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
  [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
  [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
  [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr handle);
  [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr handle);
  [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr handle);
  public static TixTabMicrophone[] List() {
    var devices = new List<TixTabMicrophone>();
    IntPtr preferred=Marshal.AllocHGlobal(4), flags=Marshal.AllocHGlobal(4), length=Marshal.AllocHGlobal(4);
    try {
      bool hasDefault=waveInMessage(new IntPtr(-1),0x2015,preferred,flags)==0;
      for(uint i=0;i<waveInGetNumDevs();i++) {
        Caps caps;
        if(waveInGetDevCapsW(new UIntPtr(i),out caps,(uint)Marshal.SizeOf(typeof(Caps)))!=0)continue;
        if(waveInMessage(new IntPtr(i),0x80D,length,IntPtr.Zero)!=0)continue;
        int bytes=Marshal.ReadInt32(length);
        if(bytes<=0||bytes>16384)continue;
        IntPtr value=Marshal.AllocHGlobal(bytes);
        try {
          if(waveInMessage(new IntPtr(i),0x80C,value,new IntPtr(bytes))!=0)continue;
          string identity=Marshal.PtrToStringUni(value).ToLowerInvariant();
          devices.Add(new TixTabMicrophone {id="winmm:"+Convert.ToBase64String(Encoding.UTF8.GetBytes(identity)),name=caps.name,index=i,isDefault=hasDefault&&i==(uint)Marshal.ReadInt32(preferred)});
        } finally {Marshal.FreeHGlobal(value);}
      }
    } finally {Marshal.FreeHGlobal(preferred);Marshal.FreeHGlobal(flags);Marshal.FreeHGlobal(length);}
    return devices.ToArray();
  }
  public static TixTabMicrophone Find(string identity) {
    foreach(var device in List())if(String.IsNullOrEmpty(identity)?device.isDefault:device.id==identity)return device;
    throw new InvalidOperationException("microphone-missing");
  }
  static void Check(uint code) {if(code!=0)throw new IOException("microphone");}
  public Stream Open() {return new Input(index,null);}
  public Stream Open(Action<int> level) {return new Input(index,level);}
  sealed class Input : Stream {
    readonly object gate=new object();
    readonly Queue<byte[]> chunks=new Queue<byte[]>();
    readonly List<IntPtr> buffers=new List<IntPtr>();
    readonly AutoResetEvent signal=new AutoResetEvent(false);
    readonly uint size=(uint)Marshal.SizeOf(typeof(Header));
    readonly Action<int> level;
    IntPtr handle; Thread pump; volatile bool stopped; Exception failure; int offset, queued;
    long position;
    public Input(uint index,Action<int> onLevel) {
      level=onLevel;
      try {
        var format=new Format {tag=1,channels=1,rate=16000,bytes=32000,align=2,bits=16};
        Check(waveInOpen(out handle,index,ref format,signal.SafeWaitHandle.DangerousGetHandle(),IntPtr.Zero,0x50000));
        for(int i=0;i<4;i++) {
          IntPtr header=Marshal.AllocHGlobal((int)size), data=Marshal.AllocHGlobal(3200);
          Marshal.StructureToPtr(new Header {data=data,length=3200},header,false);
          buffers.Add(header);
          Check(waveInPrepareHeader(handle,header,size));
          Check(waveInAddBuffer(handle,header,size));
        }
        Check(waveInStart(handle));
        pump=new Thread(Pump);pump.IsBackground=true;pump.Start();
      } catch {Dispose();throw;}
    }
    void Pump() {
      try {
        while(!stopped) {
          signal.WaitOne(100);
          foreach(IntPtr pointer in buffers) {
            if(stopped)break;
            var header=(Header)Marshal.PtrToStructure(pointer,typeof(Header));
            if((header.flags&1)==0)continue;
            if(header.recorded>0) {
              byte[] bytes=new byte[header.recorded];Marshal.Copy(header.data,bytes,0,bytes.Length);
              if(level!=null) {
                double sum=0;for(int i=0;i+1<bytes.Length;i+=2){double sample=(short)(bytes[i]|bytes[i+1]<<8);sum+=sample*sample;}
                level(Math.Min(100,(int)Math.Round(Math.Sqrt(sum/(bytes.Length/2))*500/32768)));
              }
              lock(gate) {if(queued+bytes.Length>96000)throw new IOException("microphone");chunks.Enqueue(bytes);queued+=bytes.Length;Monitor.PulseAll(gate);}
            }
            Check(waveInAddBuffer(handle,pointer,size));
          }
        }
      } catch(Exception error) {lock(gate){failure=error;Monitor.PulseAll(gate);}}
    }
    public override int Read(byte[] target,int at,int count) {
      if(count==0)return 0;
      lock(gate) {
        while(chunks.Count==0&&!stopped&&failure==null)Monitor.Wait(gate,200);
        if(failure!=null)throw new IOException("microphone",failure);
        if(chunks.Count==0)return 0;
        byte[] bytes=chunks.Peek();int n=Math.Min(count,bytes.Length-offset);
        Buffer.BlockCopy(bytes,offset,target,at,n);offset+=n;queued-=n;position+=n;
        if(offset==bytes.Length){chunks.Dequeue();offset=0;}return n;
      }
    }
    protected override void Dispose(bool disposing) {
      if(stopped)return;
      lock(gate){stopped=true;Monitor.PulseAll(gate);}signal.Set();
      if(pump!=null)pump.Join();
      if(handle!=IntPtr.Zero) {
        waveInReset(handle);
        foreach(IntPtr pointer in buffers){waveInUnprepareHeader(handle,pointer,size);var header=(Header)Marshal.PtrToStructure(pointer,typeof(Header));Marshal.FreeHGlobal(header.data);Marshal.FreeHGlobal(pointer);}
        waveInClose(handle);handle=IntPtr.Zero;
      }
      signal.Dispose();base.Dispose(disposing);
    }
    public override bool CanRead {get{return true;}} public override bool CanWrite {get{return false;}} public override bool CanSeek {get{return false;}}
    // SAPI's Stream wrapper reads Length/Position even for a live, nonseekable input.
    public override long Length {get{return Int64.MaxValue;}} public override long Position {get{lock(gate)return position;}set{Seek(value,SeekOrigin.Begin);}}
    public override void Flush(){} public override long Seek(long n,SeekOrigin origin){lock(gate){long next=origin==SeekOrigin.Current?position+n:origin==SeekOrigin.Begin?n:-1;if(next!=position)throw new NotSupportedException();return position;}}
    public override void SetLength(long n){throw new NotSupportedException();} public override void Write(byte[] b,int a,int n){throw new NotSupportedException();}
  }
}
