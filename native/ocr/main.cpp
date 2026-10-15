// AGPL-3.0-only. Tesseract/Leptonica retain their upstream licenses.
// Binary stdin frames: uint32 little-endian PNG byte length, followed by PNG.
// One JSON line per frame; stdout contains no diagnostics or image/text logs.
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>
#include <tesseract/baseapi.h>
#include <tesseract/resultiterator.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <filesystem>
#include <fstream>
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
#ifdef TIXTAB_NPU
#include "npu.h"
static std::unique_ptr<NpuRecognizer> accelerator;
#endif
static void checked(HRESULT code) { if (FAILED(code)) throw std::runtime_error("invalid-image"); }
static std::string jsonString(const std::string& value) {
  std::string out = "\"";
  const char* hex = "0123456789abcdef";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
    else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
    else out += char(c);
  }
  return out + '"';
}
static std::string utf8(const wchar_t* value) {
  const int n = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) throw std::runtime_error("invalid-path");
  std::string out(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), n, nullptr, nullptr);
  out.pop_back(); return out;
}
static bool readModel(const char* name, std::vector<char>* bytes) {
  std::ifstream file(std::filesystem::u8path(name), std::ios::binary | std::ios::ate);
  if (!file) return false;
  const auto size = file.tellg();
  if (size <= 0 || size > 64 * 1024 * 1024) return false;
  bytes->resize(size_t(size)); file.seekg(0);
  return bool(file.read(bytes->data(), size));
}
static std::string text(tesseract::ResultIterator* it, tesseract::PageIteratorLevel level) {
  std::unique_ptr<char[]> data(it->GetUTF8Text(level));
  std::string out = data ? data.get() : "";
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
  if (out.size() > 10000) throw std::runtime_error("output-limit");
  return out;
}
static std::string polygon(tesseract::PageIterator* it, tesseract::PageIteratorLevel level, UINT w, UINT h) {
  int a = 0, b = 0, c = 0, d = 0;
  it->BoundingBox(level, &a, &b, &c, &d);
  a = std::clamp(a, 0, int(w)); c = std::clamp(c, a, int(w));
  b = std::clamp(b, 0, int(h)); d = std::clamp(d, b, int(h));
  return "[" + std::to_string(a) + "," + std::to_string(b) + "," + std::to_string(c) + "," + std::to_string(b) + "," + std::to_string(c) + "," + std::to_string(d) + "," + std::to_string(a) + "," + std::to_string(d) + "]";
}
static std::string recognize(tesseract::TessBaseAPI& api, IWICImagingFactory* factory, std::vector<uint8_t>& bytes) {
  const auto start = Clock::now();
  ComPtr<IWICStream> stream;
  checked(factory->CreateStream(&stream));
  checked(stream->InitializeFromMemory(bytes.data(), DWORD(bytes.size())));
  ComPtr<IWICBitmapDecoder> decoder;
  checked(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder));
  ComPtr<IWICBitmapFrameDecode> frame;
  checked(decoder->GetFrame(0, &frame));
  UINT w = 0, h = 0;
  checked(frame->GetSize(&w, &h));
  if (!w || !h || w > 8192 || h > 8192 || uint64_t(w) * h > 4000000) throw std::runtime_error("image-limit");
  ComPtr<IWICFormatConverter> converter;
  checked(factory->CreateFormatConverter(&converter));
  checked(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppPRGBA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  std::vector<uint8_t> rgba(size_t(w) * h * 4);
  checked(converter->CopyPixels(nullptr, w * 4, UINT(rgba.size()), rgba.data()));
  std::vector<uint8_t> pixels(size_t(w) * h);
  for (size_t i = 0; i < pixels.size(); ++i) {
    const auto* p = rgba.data() + i * 4;
    pixels[i] = uint8_t(std::min(255, 255 - p[3] + ((77 * p[0] + 150 * p[1] + 29 * p[2] + 128) >> 8)));
  }
  std::vector<uint8_t>().swap(rgba);
  api.SetImage(pixels.data(), int(w), int(h), 1, int(w));
  api.SetSourceResolution(300);
  const auto infer = Clock::now();
  double compileMs = 0, layoutMs = 0;
#ifdef TIXTAB_NPU
  accelerator->compileMs=0;accelerator->inferenceMs=0;
  std::unique_ptr<tesseract::PageIterator> it(api.AnalyseLayout());
  layoutMs=std::chrono::duration<double,std::milli>(Clock::now()-infer).count();
  std::string lines,full;size_t count=0;
  if(it) do {
    if(it->Empty(tesseract::RIL_TEXTLINE))continue;
    int x0,y0,x1,y1;
    if(!it->BoundingBox(tesseract::RIL_TEXTLINE,&x0,&y0,&x1,&y1) || x0<0 || y0<0 || x1>int(w) || y1>int(h) || x1<=x0 || y1<=y0)continue;
    if(++count>4096)throw std::runtime_error("output-limit");
    const int span=std::max(1,int((y1-y0)*1530.0/36));std::string value;
    for(int left=x0;left<x1;left+=span)value+=accelerator->line(pixels,w,left,y0,std::min(span,x1-left),y1-y0);
    while(!value.empty()&&value.front()==' ')value.erase(0,1);
    while(!value.empty()&&value.back()==' ')value.pop_back();
    if(!lines.empty()){lines+=',';full+='\n';}full+=value;
    if(full.size()>100000)throw std::runtime_error("output-limit");
    lines+="{\"text\":"+jsonString(value)+",\"polygon\":"+polygon(it.get(),tesseract::RIL_TEXTLINE,w,h)+"}";
  }while(it->Next(tesseract::RIL_TEXTLINE));
  const double inferenceMs=accelerator->inferenceMs;compileMs=accelerator->compileMs;
#else
  if (api.Recognize(nullptr)) throw std::runtime_error("recognition-failed");
  const double inferenceMs = std::chrono::duration<double, std::milli>(Clock::now() - infer).count();
  std::unique_ptr<tesseract::ResultIterator> it(api.GetIterator());
  std::string lines, full;
  size_t count = 0, wordCount = 0;
  if (it) {
    bool firstLine = true, firstWord = true;
    do {
      if (it->Empty(tesseract::RIL_WORD)) continue;
      if (firstLine || it->IsAtBeginningOf(tesseract::RIL_TEXTLINE)) {
        if (++count > 4096) throw std::runtime_error("output-limit");
        const auto line = text(it.get(), tesseract::RIL_TEXTLINE);
        if (!firstLine) { lines += "]},"; full += '\n'; }
        full += line;
        if (full.size() > 100000) throw std::runtime_error("output-limit");
        lines += "{\"text\":" + jsonString(line) + ",\"polygon\":" + polygon(it.get(), tesseract::RIL_TEXTLINE, w, h) + ",\"confidence\":" + std::to_string(std::clamp(it->Confidence(tesseract::RIL_TEXTLINE), 0.0f, 100.0f)) + ",\"words\":[";
        firstLine = false; firstWord = true; wordCount = 0;
      }
      if (++wordCount > 2000) throw std::runtime_error("output-limit");
      if (!firstWord) lines += ',';
      lines += "{\"text\":" + jsonString(text(it.get(), tesseract::RIL_WORD)) + ",\"polygon\":" + polygon(it.get(), tesseract::RIL_WORD, w, h) + "}";
      firstWord = false;
    } while (it->Next(tesseract::RIL_WORD));
    if (!firstLine) lines += "]}";
  }
#endif
  it.reset();
  api.Clear(); // Retain language weights, release per-image recognition structures.
  const double totalMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
  std::string device;
#ifdef TIXTAB_NPU
  device=",\"device\":\"NPU\",\"executionDevices\":"+jsonString(accelerator->executionDevices)+",\"loadedFromCache\":"+jsonString(accelerator->loadedFromCache);
#else
  device=",\"device\":\"CPU (native)\"";
#endif
  return "{\"ok\":true,\"text\":" + jsonString(full) + device + ",\"lines\":[" + lines + "],\"width\":" + std::to_string(w) + ",\"height\":" + std::to_string(h) + ",\"timing\":{\"layoutMs\":"+std::to_string(layoutMs)+",\"compileMs\":"+std::to_string(compileMs)+",\"inferenceMs\":" + std::to_string(inferenceMs) + ",\"serviceMs\":" + std::to_string(totalMs) + "}}";
}
int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  if (argc != 3) return 2;
  try {
    checked(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    ComPtr<IWICImagingFactory> factory;
    checked(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
    tesseract::TessBaseAPI api;
    const auto root = utf8(argv[1]), language = utf8(argv[2]);
#ifdef TIXTAB_NPU
    accelerator=std::make_unique<NpuRecognizer>(argv[1],argv[2]);
    api.InitForAnalysePage();
#else
    if (api.Init(root.c_str(), 0, language.c_str(), tesseract::OEM_LSTM_ONLY, nullptr, 0, nullptr, nullptr, false, readModel)) throw std::runtime_error("model-load-failed");
#endif
    api.SetPageSegMode(tesseract::PSM_AUTO);
    std::cout << "{\"ready\":true,\"version\":" << jsonString(api.Version()) << "}" << std::endl;
    while (true) {
      uint8_t header[4];
      if (!std::cin.read(reinterpret_cast<char*>(header), 4)) break;
      const uint32_t n = uint32_t(header[0]) | uint32_t(header[1]) << 8 | uint32_t(header[2]) << 16 | uint32_t(header[3]) << 24;
      if (!n || n > 24 * 1024 * 1024) return 3;
      std::vector<uint8_t> bytes(n);
      if (!std::cin.read(reinterpret_cast<char*>(bytes.data()), n)) return 3;
      try { std::cout << recognize(api, factory.Get(), bytes) << std::endl; }
      catch (const std::exception& e) { api.Clear(); std::cout << "{\"ok\":false,\"error\":" << jsonString(e.what()) << "}" << std::endl; }
    }
    api.End();
    return 0;
  } catch (const std::exception& e) {
    std::cout << "{\"ok\":false,\"error\":" << jsonString(e.what()) << "}" << std::endl;
    return 1;
  }
}
