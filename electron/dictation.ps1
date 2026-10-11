param([string]$Language='zh-CN',[switch]$List,[switch]$SelfTest)
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Speech
  if($List){[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { [Console]::WriteLine('LANG '+$_.Culture.Name) };exit 0}
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Text;
using System.Speech.Recognition;
public static class TixTabDictation {
  private static void Levels(SpeechRecognitionEngine engine,int interval=100) {
    int last=Environment.TickCount;
    engine.AudioLevelUpdated+=(sender,e)=>{int now=Environment.TickCount;if(unchecked(now-last)>=interval){last=now;Console.WriteLine("LEVEL "+e.AudioLevel);}};
  }
  public static void Test() {
    using(var stream=new System.IO.MemoryStream())
    using(var voice=new System.Speech.Synthesis.SpeechSynthesizer())
    using(var engine=new SpeechRecognitionEngine(new System.Globalization.CultureInfo("en-US"))) {
      voice.SelectVoiceByHints(System.Speech.Synthesis.VoiceGender.NotSet,System.Speech.Synthesis.VoiceAge.NotSet,0,new System.Globalization.CultureInfo("en-US"));
      voice.SetOutputToWaveStream(stream);
      voice.Speak("This is a test of offline speech recognition.");
      stream.Position=0;
      engine.LoadGrammar(new DictationGrammar());
      Levels(engine,0);
      engine.SetInputToWaveStream(stream);
      RecognitionResult result=null;
      using(var completed=new System.Threading.ManualResetEvent(false)) {
        engine.SpeechRecognized+=(sender,e)=>{result=e.Result;};
        engine.RecognizeCompleted+=(sender,e)=>{completed.Set();};
        engine.RecognizeAsync(RecognizeMode.Single);
        if(!completed.WaitOne(20000))throw new Exception("Recognition timed out");
      }
      if(result==null)throw new Exception("No recognized text");
      Console.WriteLine("TEST "+Convert.ToBase64String(Encoding.UTF8.GetBytes(result.Text)));
    }
  }
  public static void Run(string language) {
    RecognizerInfo selected=null;
    foreach(var info in SpeechRecognitionEngine.InstalledRecognizers()) {
      if(info.Culture.Name.Equals(language,StringComparison.OrdinalIgnoreCase)){selected=info;break;}
    }
    if(selected==null){Console.WriteLine("ERROR language");return;}
    using(var engine=new SpeechRecognitionEngine(selected)) {
      engine.LoadGrammar(new DictationGrammar());
      Levels(engine);
      engine.SpeechRecognized+=(sender,e)=>{if(e.Result!=null&&!String.IsNullOrWhiteSpace(e.Result.Text))Console.WriteLine("TEXT "+Convert.ToBase64String(Encoding.UTF8.GetBytes(e.Result.Text)));};
      engine.SetInputToDefaultAudioDevice();
      engine.RecognizeAsync(RecognizeMode.Multiple);
      Console.WriteLine("READY");
      Console.ReadLine();
      engine.RecognizeAsyncCancel();
    }
  }
}
'@
  if($SelfTest){[TixTabDictation]::Test()}else{[TixTabDictation]::Run($Language)}
} catch { [Console]::WriteLine('ERROR microphone');exit 1 }
