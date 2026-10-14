param([string]$Language='zh-CN',[string]$Microphone='',[switch]$List,[switch]$Microphones,[switch]$SelfTest)
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  if($Microphones){
    Add-Type -Path (Join-Path $PSScriptRoot 'microphone.cs')
    $inputs = @([TixTabMicrophone]::List() | ForEach-Object { @{id=$_.id;name=$_.name;isDefault=$_.isDefault} })
    @{microphones=$inputs;defaultId=(@($inputs | Where-Object {$_.isDefault} | Select-Object -First 1).id)} | ConvertTo-Json -Compress -Depth 4
    exit 0
  }
  Add-Type -AssemblyName System.Speech
  if($List){[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { [Console]::WriteLine('LANG '+$_.Culture.Name) };exit 0}
  $speechSource = @'
namespace TixTabSpeech {
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
  public static void Run(string language,string microphone) {
    RecognizerInfo selected=null;
    foreach(var info in SpeechRecognitionEngine.InstalledRecognizers()) {
      if(info.Culture.Name.Equals(language,StringComparison.OrdinalIgnoreCase)){selected=info;break;}
    }
    if(selected==null){Console.WriteLine("ERROR language");return;}
    TixTabMicrophone input;
    try {input=TixTabMicrophone.Find(microphone);}catch {Console.WriteLine("ERROR microphone-missing");return;}
    using(var engine=new SpeechRecognitionEngine(selected)) {
      engine.LoadGrammar(new DictationGrammar());
      engine.SpeechRecognized+=(sender,e)=>{if(e.Result!=null&&!String.IsNullOrWhiteSpace(e.Result.Text))Console.WriteLine("TEXT "+Convert.ToBase64String(Encoding.UTF8.GetBytes(e.Result.Text)));};
      using(var stream=input.Open(level=>Console.WriteLine("LEVEL "+level))) {
        engine.SetInputToAudioStream(stream,new System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,System.Speech.AudioFormat.AudioBitsPerSample.Sixteen,System.Speech.AudioFormat.AudioChannel.Mono));
        engine.RecognizeCompleted+=(sender,e)=>{if(e.Error!=null)Console.WriteLine("ERROR microphone");};
        Console.WriteLine("INPUT "+Convert.ToBase64String(Encoding.UTF8.GetBytes(input.name)));
        engine.RecognizeAsync(RecognizeMode.Multiple);
        Console.WriteLine("READY");
        Console.ReadLine();
        // Unblock a native stream reader before shutting down the recognizer.
        if(stream!=null)stream.Dispose();
        engine.RecognizeAsyncCancel();
      }
    }
  }
}
}
'@
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition ((Get-Content (Join-Path $PSScriptRoot 'microphone.cs') -Raw) + $speechSource)
  if($SelfTest){[TixTabSpeech.TixTabDictation]::Test()}else{[TixTabSpeech.TixTabDictation]::Run($Language,$Microphone)}
} catch { [Console]::WriteLine('ERROR microphone');exit 1 }
