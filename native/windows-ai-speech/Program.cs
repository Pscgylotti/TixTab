using System.Text;
using System.Text.Json;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Speech;
using Windows.Globalization;
using Windows.Media.Devices;
using Windows.Media.SpeechRecognition;
using Windows.Devices.Enumeration;

// Recognition and microphone handles never enter the Electron main process.
internal static class Program {
    static readonly object gate = new();
    static SpeechRecognitionModel? model;
    static StreamingRecognition? ai;
    static SpeechRecognizer? sdk;
    static string text = "";
    static bool done = true;
    static string? failure;
    static string ReadyError(AIFeatureReadyState state) => state==AIFeatureReadyState.NotReady?"model-not-ready":"windows-ai-state-"+state;
    static void Append(string value) { lock(gate) { var addition=(text.Length == 0 ? "" : "\n") + value; var remaining=16000-text.Length; if(remaining>0) text+=addition[..Math.Min(addition.Length,remaining)]; } }
    static async Task Stop() {
        try { if(ai != null) { ai.StopContinuousRecognition(); await Task.Delay(150); } if(sdk != null) await sdk.ContinuousRecognitionSession.StopAsync(); }
        catch { failure="inference"; /* Do not auto-send incomplete results after a failed stop. */ }
        finally { ai?.Dispose(); ai=null; sdk?.Dispose(); sdk=null; model?.Dispose(); model=null; done=true; }
    }
    static async Task<object> Run(JsonElement c) {
        var action=c.GetProperty("action").GetString();
        var engine=c.TryGetProperty("engine",out var e)?e.GetString():"windows-ai";
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
            operation.Progress=(_,p)=>Console.WriteLine(JsonSerializer.Serialize(new {progress=new {stage=p.Status.ToString(),value=p.Progress}}));
            var r=await operation;
            var success=r.Status==AIFeatureReadyResultState.Success;
            return new {ok=success, error=success?null:"windows-ai-model-prepare", hresult=r.ExtendedError is null?null:$"0x{r.ExtendedError.HResult:X8}",
                data=new {state=r.Status.ToString(), reason=r.Error.ToString(), detail=r.ErrorDisplayText, packageInstallationFailed=r.PackageInstallationFailed}};
        }
        if(action=="start") {
            if(!done) return new {ok=false,error="busy"};
            await Stop(); text=""; failure=null;
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
            } else {
                var state=SpeechRecognitionModel.GetReadyState();
                if(state!=AIFeatureReadyState.Ready) return new {ok=false,error=ReadyError(state),data=new {state=state.ToString()}};
                var devices=await DeviceInformation.FindAllAsync(MediaDevice.GetAudioCaptureSelector());
                var chosen=c.TryGetProperty("microphoneName",out var m)?m.GetString():null;
                var device=string.IsNullOrEmpty(chosen)
                    ? await DeviceInformation.CreateFromIdAsync(MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Communications))
                    : devices.FirstOrDefault(d=>d.Name==chosen) ?? (devices.Count(d=>d.Name.StartsWith(chosen,StringComparison.OrdinalIgnoreCase))==1?devices.First(d=>d.Name.StartsWith(chosen,StringComparison.OrdinalIgnoreCase)):null);
                if(device==null) return new {ok=false,error="microphone-missing"};
                var created=await SpeechRecognitionModel.TryCreateAsync();
                model=created.SpeechModel;
                if(model==null) return new {ok=false,error="windows-ai-unavailable"};
                ai=new StreamingRecognition(AudioConfiguration.FromAudioDevice(device.Name),model);
                ai.Recognized += (_,args)=>Append(args.Text);
                done=false;
                await ai.StartContinuousRecognitionAsync();
            }
            return new {ok=true};
        }
        if(action=="stop") { await Stop(); return new {ok=true}; }
        if(action=="read") { lock(gate) { var value=text; text=""; return new {ok=true,data=new {text=value,done,error=failure,ready=!done,device=engine=="windows-sdk"?"Windows SDK":"Windows AI (AUTO)"}}; } }
        return new {ok=false,error="invalid"};
    }
    static async Task Main() {
        Console.InputEncoding=Console.OutputEncoding=new UTF8Encoding(false);
        try {
            while(await Console.In.ReadLineAsync() is string line) {
                object response;
                try { using var json=JsonDocument.Parse(line); response=await Run(json.RootElement); }
                catch(Exception ex) { await Stop(); response=new {ok=false,error=ex.HResult==unchecked((int)0x80070005)?"windows-ai-identity":"windows-ai-unavailable",hresult=$"0x{ex.HResult:X8}"}; }
                Console.WriteLine(JsonSerializer.Serialize(response));
            }
        } finally { await Stop(); }
    }
}
