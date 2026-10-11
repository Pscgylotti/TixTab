# 本地模型来源

仅在准备模型时联网；应用内推理关闭远程模型加载。下载目录 `public/models/` 不进入 Git，构建后复制到桌面资源。需要重新分发时，同时遵守代码、原始权重与转换权重的上游条款。

| 用途 | 模型与固定版本 | 来源与许可 |
| --- | --- | --- |
| 公式 | `alephpi/FormulaNet`，`b2668efe5112082846fde4d446b9bfaab3989533`，约 80MB | [Texo](https://github.com/alephpi/Texo)，AGPL-3.0；保留上游模型说明与来源。下载脚本记录文件 SHA256。 |
| 英→中 | `Xenova/opus-mt-en-zh`，`046f55aec303cdee3e0318604406d4df20f1e8ea`，约 119.5MB | [ONNX 转换](https://huggingface.co/Xenova/opus-mt-en-zh)，原始模型由 [Helsinki-NLP](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) 提供，Apache-2.0。 |
| 中→英 | `Xenova/opus-mt-zh-en`，`39d480d52a9ea3065a1f117adfe4dbc55de10e6f`，约 119.5MB | [ONNX 转换](https://huggingface.co/Xenova/opus-mt-zh-en)，原始模型由 [Helsinki-NLP](https://huggingface.co/Helsinki-NLP/opus-mt-zh-en) 提供，CC BY 4.0。感谢 Helsinki-NLP / OPUS 团队；使用量化 ONNX 转换权重。 |

翻译仅下载 q8 encoder 与 merged decoder，固定权重 SHA256 验证。每个目录的 `manifest.json` 记录来源、revision、文件大小和校验值。

Google 在线接入遵循[官方 Cloud Translation Basic REST 协议](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate)；无密钥时提供官方网页入口。尚未使用真实付费密钥验证配额/账单/地区连通性，协议已用模拟响应验证。

## OCR 与朗读（2026-10-11）

- [Tesseract.js 7.0.0](https://github.com/naptha/tesseract.js)：Apache-2.0；本地 LSTM/WASM OCR。`tesseract-ocr/tessdata_fast` 固定提交 `87416418657359cb625c412a48b6e1d6d41c29bd`，`eng` + `chi_sim` 合计约 6.6MB，运行时关闭 CDN 路径。
- [Piper 浏览器实现 1.0.5](https://github.com/Mintplex-Labs/piper-tts-web)：MIT 包装层，音素运行时含 eSpeak-NG，需保留其 GPL 许可。准备脚本将模型地址改为本机资源、单线程 WASM，并按实际声音的 `phoneme_id_map` 映射音素，避免中文模型误用英语 ID。
- 声音源 `rhasspy/piper-voices` 固定提交 `c10ece1aade47bb51c153c893d14e5bf8e5b7117`，`en_US-lessac-low` 约 63.2MB，`zh_CN-huayan-x_low` 约 20.6MB；模型卡随下载保存。**模型许可不等于包装库 MIT**：Lessac 数据集有自己的许可链接，Huayan 模型卡标注数据集许可 Unknown；当前仅本机原型验证，重新分发这些声音前须核实权重/数据许可。
- 语音单次选区上限 4000 字符；按需加载、取消与闲置释放。0.2.11 原生实验路径已实际完成中英 NPU/GPU/CPU WAV 合成和内置 WASM 回退；仅波形生成适配加速设备，音素、时长/流变换与尾段仍为 CPU。未系统评测发音准确率或真实功耗。
- `npm run model:reading` 准备 OCR/Piper，固定版本资源的大小、SHA256 和来源写入 `public/models/reading-manifest.json`。首次准备记录哈希，后续复用时按清单校验。

悬浮键盘使用 [simple-keyboard 3.8.119](https://github.com/hodgef/simple-keyboard)，MIT。Etymonline 使用官网悬浮窗口，没有发现官方公开 API 文档，不抓取或离线打包官网词条。

## Texo OpenVINO 本地加速（0.2.3）

使用同一固定版本 Texo ONNX 权重，无额外模型下载。静态 384×384 视觉编码器适配 NPU/GPU/CPU；合并解码器的缓存条件分支常量折叠为首步/后续两图，保留原权重与计算，在 CPU 上使用两线程运行。默认依次尝试 NPU、GPU、CPU；单设备手动选择失败则回退 CPU；整个原生后端不可用则回退内置单线程 WASM。NPU 优先是设备策略，尚无瓦特/电池实测结论。

OpenVINO 固定 2026.2.0，依赖见 `backend/requirements-openvino.txt`，Python 3.10 x64 运行时隔离在 `%USERPROFILE%/.surfacetab/openvino-runtime`，避免调用方的 AppData 重定向影响独立启动。本地监听 127.0.0.1:8766，桌面按需启动并在退出时结束自身启动的服务；手动启动的服务由启动者管理。模型闲置 120 秒释放会话，编译结果缓存到 `%LOCALAPPDATA%/SurfaceTab/openvino-cache`。仅在首次安装依赖时联网。

便携包内包含后端源文件，使用包内 ASAR 的 Texo 权重：首次提取约 80MB 到本机模型缓存，校验清单中的大小与 SHA256，不把 Python 运行时重复装进每次便携解压目录。开发环境优先复用 `public/models/texo`。

参考：[OpenVINO 支持设备](https://docs.openvino.ai/2026/documentation/compatibility-and-support/supported-devices.html)、[NPU 文档](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/npu-device.html)。动态自回归解码本版仍使用 CPU，不宣称全模型 NPU 推理。Piper 从 0.2.11 起另有波形生成原生加速，保留现有 WASM 实现，见 [PIPER-NATIVE.md](PIPER-NATIVE.md)。文字 OCR 从 0.2.10 起提供 PP-OCRv4 OpenVINO，可选 NPU/GPU/CPU，并保留 Tesseract WASM 回退。OPUS 从 0.2.8 起另提供显式可选的实验性原生路径，默认内置 WASM 保留；不能将原生实验路线与原 q8 基线视为逐 token 等价，详见 [OPUS-NATIVE.md](OPUS-NATIVE.md)。

## PP-OCRv4 文字识别（0.2.10）

RapidOCR 3.10.0（Apache-2.0）复用 PaddleOCR 的检测、方向分类、识别前后处理。固定中英移动端 ONNX 检测 4,745,517 字节、识别 10,857,958 字节、方向分类 585,532 字节，总计 16,189,007 字节。`npm run model:ocr` 按上游注册表的固定 URL、大小和 SHA256 准备资源；权重不修改，来源/清单/许可随资源保存。

可选 OCR Python 依赖：`backend/start-openvino.ps1 -Install -Ocr`，使用已有隔离运行时。没有这些依赖或旧服务没有 OCR 能力时使用内置 Tesseract；不会自动下载模型或字体。区域识别默认低功耗优先，可选择 Tesseract 或手动设备，记住本地后端/设备偏好。

NPU/GPU 固定 768px 检测块，64px 重叠、最大边 1472px/至多四块，先合并概率图再找文本框；识别宽度 320/640/1280，超过该宽度使用完整 CPU 行识别，不裁断。识别在字符投影前拆分，投影与方向分类使用 2 线程 CPU。最多 6 个 LRU 会话加 1 个 CPU 投影会话，编译缓存目标 256MiB；单请求、取消检查、120 秒闲置释放和 Texo/OPUS 共用生命周期。详见 [OCR-NATIVE.md](OCR-NATIVE.md)。
