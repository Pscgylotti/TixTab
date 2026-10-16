using System.Text;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Speech;
using Microsoft.Windows.AI.MachineLearning;
using Windows.Globalization;
using Windows.Media.Devices;
using Windows.Media.SpeechRecognition;
using Windows.Devices.Enumeration;

// Recognition and microphone handles never enter the Electron main process.
internal static class Program {
    static readonly object gate = new();
    static SpeechRecognitionModel? model;
    static StreamingRecognition? ai;
    static Task? aiStart;
    static volatile int recognitionGeneration;
    static SpeechRecognizer? sdk;
    static AudioLevelMeter? meter;
    static string text = "";
    static volatile bool done = true;
    static volatile string? failure;
    static volatile string stage="request";
    static void Report(string value, double progress=0, string action="start") {
        stage=value;
        Console.WriteLine(JsonSerializer.Serialize(new {progress=new {stage=value,value=progress,action}}));
    }
    static async Task LoadModel(string action="start") {
        if(model!=null) { Report("model-ready",1,action); return; }
        Report("provider-register",0,action);
        await ExecutionProviderCatalog.GetDefault().RegisterCertifiedAsync();
        Report("model-loading",0,action);
        var operation=SpeechRecognitionModel.TryCreateAsync();
        operation.Progress=(_,p)=>Report("model-loading",p.Progress/100.0,action);
        var created=await operation;
        model=created.SpeechModel;
        if(model==null) throw created.ExtendedError ?? new InvalidOperationException("Windows speech model could not be loaded.");
        Report("model-ready",1,action);
    }
    static string ReadyError(AIFeatureReadyState state) => state==AIFeatureReadyState.NotReady?"model-not-ready":"windows-ai-state-"+state;
    static void Append(string value) { lock(gate) { var addition=(text.Length == 0 ? "" : "\n") + value; var remaining=16000-text.Length; if(remaining>0) text+=addition[..Math.Min(addition.Length,remaining)]; } }
    static async Task ObserveStart(Windows.Foundation.IAsyncAction operation,int current) {
        try { await operation; if(current==recognitionGeneration && !done) Report("listening",1); }
        catch(Exception ex) {
            var cancelled=ex is OperationCanceledException || ex.HResult==unchecked((int)0x80004004) || ex.HResult==unchecked((int)0x800704C7);
            if(current==recognitionGeneration && (!done || !cancelled)) { failure=ex.HResult==unchecked((int)0x80070005)?"microphone":"inference"; done=true; }
        }
    }
    static async Task Stop(bool releaseModel=true) {
        done=true;
        meter?.Dispose(); meter=null;
        try { if(ai != null) { ai.StopContinuousRecognition(); if(aiStart!=null) await aiStart.WaitAsync(TimeSpan.FromSeconds(5)); await Task.Delay(150); } if(sdk != null) await sdk.ContinuousRecognitionSession.StopAsync(); }
        catch { failure="inference"; /* Do not auto-send incomplete results after a failed stop. */ }
        finally { recognitionGeneration++; ai?.Dispose(); ai=null; aiStart=null; sdk?.Dispose(); sdk=null; if(releaseModel || failure!=null) { model?.Dispose(); model=null; } done=true; }
    }
    static async Task<object> Run(JsonElement c) {
        var action=c.GetProperty("action").GetString();
        var engine=c.TryGetProperty("engine",out var e)?e.GetString():"windows-ai";
        if(action=="load") {
            var timer=Stopwatch.StartNew();
            await LoadModel("load");
            return new {ok=true,data=new {stage,elapsedMs=timer.ElapsedMilliseconds}};
        }
        if(action=="status") {
            // A status check must not claim readiness without the required package identity.
            try { _=Windows.ApplicationModel.Package.Current.Id.FullName; }
            catch { return new {ok=false,error="windows-ai-identity"}; }
            return new {ok=true, data=new {state=engine=="windows-sdk"?"Windows SDK":SpeechRecognitionModel.GetReadyState().ToString()}};
        }
        if(action=="prepare") {
            var state=SpeechRecognitionModel.GetReadyState();
            if(state==AIFeatureReadyState.Ready) return new {ok=true,data=new {state="Ready"}};
            if(state!=AIFeatureReadyState.NotReady) return new {ok=false,error=ReadyError(state),data=new {state=state.ToString()}};
            var operation=SpeechRecognitionModel.EnsureReadyAsync();
            operation.Progress=(_,p)=>Console.WriteLine(JsonSerializer.Serialize(new {progress=new {stage=p.Status.ToString(),value=p.Progress/100.0}}));
            var r=await operation;
            var success=r.Status==AIFeatureReadyResultState.Success;
            return new {ok=success, error=success?null:"windows-ai-model-prepare", hresult=r.ExtendedError is null?null:$"0x{r.ExtendedError.HResult:X8}",
                data=new {state=r.Status.ToString(), reason=r.Error.ToString(), detail=r.ErrorDisplayText, packageInstallationFailed=r.PackageInstallationFailed}};
        }
        if(action=="start") {
            if(!done) return new {ok=false,error="busy"};
            await Stop(false); text=""; failure=null;
            Report("readiness");
            var language=c.GetProperty("language").GetString()!;
            if(engine=="windows-sdk") {
                // Windows SDK dictation can use the online Windows speech service.
                sdk=new SpeechRecognizer(new Language(language));
                sdk.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation,"dictation"));
                var compiled=await sdk.CompileConstraintsAsync();
                if(compiled.Status!=SpeechRecognitionResultStatus.Success) { sdk.Dispose(); sdk=null; return new {ok=false,error="speech-privacy"}; }
                sdk.ContinuousRecognitionSession.ResultGenerated += (_,args)=>{ if(args.Result.Status==SpeechRecognitionResultStatus.Success) Append(args.Result.Text); };
                sdk.ContinuousRecognitionSession.Completed += (_,args)=> { done=true; if(args.Status!=SpeechRecognitionResultStatus.Success) failure="inference"; };
                done=false;
                await sdk.ContinuousRecognitionSession.StartAsync();
                meter=AudioLevelMeter.TryOpen();
            } else {
                var state=SpeechRecognitionModel.GetReadyState();
                if(state!=AIFeatureReadyState.Ready) return new {ok=false,error=ReadyError(state),data=new {state=state.ToString()}};
                Report("microphone-select");
                var devices=await DeviceInformation.FindAllAsync(MediaDevice.GetAudioCaptureSelector());
                var chosen=c.TryGetProperty("microphoneName",out var m)?m.GetString():null;
                var device=string.IsNullOrEmpty(chosen)
                    ? await DeviceInformation.CreateFromIdAsync(MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Communications))
                    : devices.FirstOrDefault(d=>d.Name==chosen) ?? (devices.Count(d=>d.Name.StartsWith(chosen,StringComparison.OrdinalIgnoreCase))==1?devices.First(d=>d.Name.StartsWith(chosen,StringComparison.OrdinalIgnoreCase)):null);
                if(device==null) return new {ok=false,error="microphone-missing"};
                await LoadModel();
                Report("recognizer-create");
                ai=new StreamingRecognition(AudioConfiguration.FromAudioDevice(device.Name),model);
                var current=++recognitionGeneration;
                ai.Recognized += (_,args)=> { if(current==recognitionGeneration) { Append(args.Text); if(!done && stage!="listening") Report("listening",1); } };
                done=false;
                Report("microphone-start");
                // Some experimental runtimes keep this operation pending for the
                // capture lifetime. Never block command reads or Stop behind it.
                aiStart=ObserveStart(ai.StartContinuousRecognitionAsync(),current);
                meter=AudioLevelMeter.TryOpen(device.Id);
            }
            return new {ok=true};
        }
        if(action=="stop") { Report("stopping",0,"stop"); await Stop(false); return new {ok=true}; }
        if(action=="read") { lock(gate) { var value=text; text=""; return new {ok=true,data=new {text=value,done,error=failure,ready=!done,stage,level=done?0:meter?.ReadLevel()??0,levelAvailable=!done && meter?.Available==true,device=engine=="windows-sdk"?"Windows SDK":"Windows AI (AUTO)"}}; } }
        return new {ok=false,error="invalid"};
    }
    static async Task Main() {
        Console.InputEncoding=Console.OutputEncoding=new UTF8Encoding(false);
        try {
            while(await Console.In.ReadLineAsync() is string line) {
                object response;
                try { using var json=JsonDocument.Parse(line); response=await Run(json.RootElement); }
                catch(Exception ex) { await Stop(); response=new {ok=false,error=ex.HResult==unchecked((int)0x80070005)?"windows-ai-identity":"windows-ai-unavailable",hresult=$"0x{ex.HResult:X8}",data=new {stage,detail=ex.Message[..Math.Min(ex.Message.Length,500)]}}; }
                Console.WriteLine(JsonSerializer.Serialize(response));
            }
        } finally { await Stop(); }
    }
}
