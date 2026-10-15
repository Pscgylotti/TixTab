// Experimental OpenVINO C ABI consumer; no Python or CPU neural inference.
#pragma once
#include <openvino/c/openvino.h>
#include <map>
#include <cmath>
class NpuRecognizer {
  struct Profile {
    ov_compiled_model_t* model = nullptr;
    ov_infer_request_t* request = nullptr;
    ov_tensor_t* input = nullptr;
    ~Profile() { if(input) ov_tensor_free(input); if(request) ov_infer_request_free(request); if(model) ov_compiled_model_free(model); }
  };
  ov_core_t* core = nullptr;
  std::filesystem::path folder;
  std::map<int,std::unique_ptr<Profile>> profiles;
  std::vector<std::string> codes;
  uint32_t blank = 0;
  static void check(ov_status_e value) { if(value != OK) throw std::runtime_error("openvino-npu-error-"+std::to_string(int(value))); }
  static uint32_t integer(std::ifstream& input) {
    uint8_t b[4]; if(!input.read(reinterpret_cast<char*>(b),4)) throw std::runtime_error("invalid-charset");
    return uint32_t(b[0]) | uint32_t(b[1])<<8 | uint32_t(b[2])<<16 | uint32_t(b[3])<<24;
  }
  Profile& profile(int width) {
    const auto old = profiles.find(width); if(old != profiles.end()) return *old->second;
    const auto before = Clock::now();
    auto value = std::make_unique<Profile>();
    const auto file = (folder / (std::to_string(width)+".xml")).wstring();
    check(ov_core_compile_model_from_file_unicode(core,file.c_str(),"NPU",2,&value->model,"PERFORMANCE_HINT","LATENCY"));
    char* device = nullptr;
    check(ov_compiled_model_get_property(value->model,"EXECUTION_DEVICES",&device));
    const std::string actual = device ? device : ""; ov_free(device);
    if(actual.find("NPU") == std::string::npos || actual.find("CPU") != std::string::npos || actual.find("GPU") != std::string::npos) throw std::runtime_error("unexpected-inference-device");
    executionDevices = actual;
    char* cached = nullptr;
    if(ov_compiled_model_get_property(value->model,"LOADED_FROM_CACHE",&cached)==OK){loadedFromCache=cached ? cached : "";ov_free(cached);}
    check(ov_compiled_model_create_infer_request(value->model,&value->request));
    int64_t dims[] = {1,36,width,1}; ov_shape_t shape{};
    check(ov_shape_create(4,dims,&shape));
    const auto status = ov_tensor_create(F32,shape,&value->input); ov_shape_free(&shape); check(status);
    check(ov_infer_request_set_input_tensor(value->request,value->input));
    compileMs += std::chrono::duration<double,std::milli>(Clock::now()-before).count();
    return *profiles.emplace(width,std::move(value)).first->second;
  }
public:
  std::string executionDevices;
  std::string loadedFromCache;
  double compileMs = 0, inferenceMs = 0;
  NpuRecognizer(const wchar_t* models, const wchar_t* cache):folder(models) {
    std::ifstream charset(folder / "codes.bin",std::ios::binary);
    if(!charset) throw std::runtime_error("missing-npu-models");
    blank = integer(charset); const auto count = integer(charset);
    if(count>4096 || blank>=count) throw std::runtime_error("invalid-charset");
    for(uint32_t i=0;i<count;++i) {
      const auto n=integer(charset); if(n>64) throw std::runtime_error("invalid-charset");
      std::string s(n,0); if(!charset.read(s.data(),n)) throw std::runtime_error("invalid-charset"); codes.push_back(s);
    }
    check(ov_core_create(&core));
    std::filesystem::create_directories(cache);
    const auto cacheString = std::filesystem::path(cache).u8string();
    check(ov_core_set_property(core,"NPU","CACHE_DIR",cacheString.c_str()));
  }
  ~NpuRecognizer() { profiles.clear(); if(core) ov_core_free(core); }
  std::string line(const std::vector<uint8_t>& pixels, int pageWidth, int left, int top, int w, int h) {
    const int target = std::max(1,int(std::nearbyint(double(w)*36/h)));
    const int width = target<=378 ? 384 : target<=762 ? 768 : 1536;
    if(target>1530) throw std::runtime_error("line-limit");
    auto& p = profile(width); void* memory = nullptr; check(ov_tensor_data(p.input,&memory));
    auto* data = static_cast<float*>(memory); std::fill(data,data+36*width,1.0f);
    // Half-pixel bilinear normalization to [-1,1], with three white columns.
    for(int y=0;y<36;++y) for(int x=0;x<target;++x) {
      const double sy=std::clamp((y+0.5)*h/36.0-0.5,0.0,double(h-1));
      const double sx=std::clamp((x+0.5)*w/target-0.5,0.0,double(w-1));
      const int y0=int(sy),x0=int(sx),y1=std::min(h-1,y0+1),x1=std::min(w-1,x0+1);
      const double a=sy-y0,b=sx-x0;
      const auto at=[&](int xx,int yy){return pixels[size_t(top+yy)*pageWidth+left+xx];};
      const double gray=(1-a)*((1-b)*at(x0,y0)+b*at(x1,y0))+a*((1-b)*at(x0,y1)+b*at(x1,y1));
      data[y*width+x+3]=float(std::round(gray)/127.5-1);
    }
    const auto before = Clock::now(); check(ov_infer_request_infer(p.request));
    inferenceMs+=std::chrono::duration<double,std::milli>(Clock::now()-before).count();
    ov_tensor_t* output = nullptr; check(ov_infer_request_get_output_tensor(p.request,&output));
    struct Release { ov_tensor_t* v; ~Release(){ov_tensor_free(v);} } release{output};
    size_t size=0; ov_element_type_e type;
    check(ov_tensor_get_size(output,&size));check(ov_tensor_get_element_type(output,&type));
    if(type!=F32 || size!=size_t(width/3)) throw std::runtime_error("invalid-classifier-output");
    check(ov_tensor_data(output,&memory)); const auto* values=static_cast<const float*>(memory);
    const int steps=std::min(width/3,(target+8)/3);int previous=-1;std::string text;
    for(int i=0;i<steps;++i) {
      const float value=values[i];
      if(!std::isfinite(value) || value<0 || value>=codes.size() || std::round(value)!=value) throw std::runtime_error("invalid-classifier-output");
      const int code=int(value);if(code!=previous && code!=int(blank)) text+=codes[code];previous=code;
    }
    return text;
  }
};
