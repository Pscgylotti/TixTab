using System.Text.Json;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Imaging;
using Microsoft.Graphics.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Foundation;

// This isolated process owns every WinRT/model/image handle. Terminating it also
// cancels an unresponsive system call, without blocking Electron's main thread.
internal static class Program
{
    static TextRecognizer? recognizer;
    static string stage = "request";
    static double[] Polygon(RecognizedTextBoundingBox box) => new double[] {
        box.TopLeft.X, box.TopLeft.Y, box.TopRight.X, box.TopRight.Y,
        box.BottomRight.X, box.BottomRight.Y, box.BottomLeft.X, box.BottomLeft.Y };
    static async Task<Response> Run(JsonElement command)
    {
        stage = "request";
        string action = command.GetProperty("action").GetString() ?? "";
        if (action == "status") { stage = "readiness"; return new Response { Ok = true, State = TextRecognizer.GetReadyState().ToString() }; }
        if (action == "open")
        {
            stage = "readiness";
            var state = TextRecognizer.GetReadyState();
            if (state == AIFeatureReadyState.NotReady)
            {
                stage = "prepare-model";
                var ready = await TextRecognizer.EnsureReadyAsync();
                if (ready.Status != AIFeatureReadyResultState.Success)
                    return new Response { Error = "model-not-ready", Detail = ready.ErrorDisplayText };
            }
            else if (state != AIFeatureReadyState.Ready)
                return new Response { Error = state.ToString() };
            stage = "create-model";
            recognizer ??= await TextRecognizer.CreateAsync();
            return new Response { Ok = true };
        }
        if (action != "recognize" || recognizer == null) return new Response { Error = "not-open" };
        string filePath = command.GetProperty("path").GetString()!;
        stage = "load-image";
        var file = await StorageFile.GetFileFromPathAsync(filePath);
        using var stream = await file.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(stream);
        if ((long)decoder.PixelWidth * decoder.PixelHeight > 4_000_000)
            return new Response { Error = "image-limit" };
        stage = "decode-image";
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        stage = "image-buffer";
        using var buffer = ImageBuffer.CreateForSoftwareBitmap(bitmap);
        stage = "recognize";
        var result = recognizer.RecognizeTextFromImage(buffer);
        stage = "read-result";
        if (result == null) throw new InvalidOperationException("Windows AI returned no recognition result.");
        // On text-free images this WinRT API can return a null Lines collection,
        // rather than an empty vector. It is a valid empty OCR result.
        var lines = result.Lines?.Take(10000).Select(line => {
            var words = line.Words?.Take(2000).ToArray() ?? [];
            return new OcrLine {
                Text = line.Text ?? "",
                Polygon = Polygon(line.BoundingBox),
                Words = words.Select(word => new OcrWord { Text = word.Text ?? "", Polygon = Polygon(word.BoundingBox) }).ToArray(),
                Confidence = words.Length > 0 ? words.Average(word => word.MatchConfidence) * 100 : 0,
            };
        }).ToArray() ?? [];
        return new Response { Ok = true, Data = new OcrData {
            Text = string.Join('\n', lines.Select(line => line.Text)), Lines = lines,
            Width = decoder.PixelWidth, Height = decoder.PixelHeight } };

    }
    static async Task Main()
    {
        Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            while (await Console.In.ReadLineAsync() is string input)
            {
                Response response;
                try
                {
                    using var json = JsonDocument.Parse(input);
                    response = await Run(json.RootElement);
                }
                catch (Exception error)
                {
                    response = new Response { Error = error.HResult == unchecked((int)0x80070005) ? "windows-ai-identity" : "windows-ai-unavailable", Hresult = $"0x{error.HResult:X8}", Detail = error.Message, Stage = stage };
                }
                Console.WriteLine(JsonSerializer.Serialize(response, OcrJson.Default.Response));
            }
        }
        finally { recognizer?.Dispose(); recognizer = null; }
    }
}

internal class Response {
    public bool Ok { get; set; }
    public string? State { get; set; }
    public string? Stage { get; set; }
    public string? Error { get; set; }
    public string? Detail { get; set; }
    public string? Hresult { get; set; }
    public OcrData? Data { get; set; }
}
internal class OcrWord {
    public string Text { get; set; } = "";
    public double[] Polygon { get; set; } = [];
}
internal class OcrLine : OcrWord {
    public OcrWord[] Words { get; set; } = [];
    public double Confidence { get; set; }
}
internal class OcrData {
    public string Text { get; set; } = "";
    public OcrLine[] Lines { get; set; } = [];
    public uint Width { get; set; }
    public uint Height { get; set; }
    public string Engine { get; set; } = "Windows AI OCR";
    public string Device { get; set; } = "NPU";
}
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Response))]
internal partial class OcrJson : JsonSerializerContext {}
