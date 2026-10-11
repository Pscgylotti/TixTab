# 本地模型管理

设置 → 本地模型管理。清单展示 10 个模型包的固定版本、下载大小、SHA256、来源、许可信息及设备路由。打开页面只检查文件状态，不启动下载、校验或推理；页面为懒加载，支持中文、English、竖屏和夜间。

## 两种应用包

- 轻量版：`SurfaceTab-0.2.23-lite-x64.exe`。包含 PDF/编辑器与推理运行库，首次启动没有模型权重；只在管理页确认下载选定模型。不支持的模型不影响 PDF、笔写、对象编辑及网页/API 功能。
- 完整离线版：`SurfaceTab-0.2.23-x64.exe`。沿用现有 33 个模型资源，无需联网下载即可使用本地基础功能。内置权重属于应用文件，不能从管理页单独删除；可以改用轻量版。

`npm run pack` 默认生成轻量版；`npm run pack:offline` 生成完整离线版。两版使用同一工作空间及用户模型目录。轻量版减少模型分发和解压数据，不能据此声称已测得瓦特或续航收益。

完整离线版内置原有基础模型；Uni-MuMER 的 1481 MiB 模型与约 32 MiB 运行时为两个可选下载，不预装。仅此后端使用 Vulkan GPU/CPU，不支持 NPU，详见 [本机实验](UNIMUMER.md)。

## 下载、校验与删除

点击下载后显示模型大小和确认信息；不自动下载整个清单。朗读需要声音包 **以及 Piper phonemizer**，两者分别下载。Texo、两个 OPUS 方向、Tesseract 中英、PP-OCRv4 互相独立。

下载在桌面主进程进行，顺序流式写入独立临时目录，同时计算 SHA256；大小/哈希不符、取消或失败的文件不会供推理使用。下载完成后原子切换目录；关闭管理页、主窗口导航/退出或主动取消都会中止当前任务。全应用同时只有一个管理任务，进度事件节流，空闲不轮询。单任务最多 20 分钟，无断点续传。

“校验文件”会逐文件读取并检查 SHA256，期间不加载推理模型。日常状态读取只检查完成记录与文件大小；显示离线可用不等于本次打开时重新计算过全部哈希。损坏的下载副本一经校验失败会取消启用，若存在内置版本则使用内置版本；仍可删除损坏副本，轻量版可重新下载修复。

“删除下载副本”需要确认，仅操作当前模型固定版本的应用私有下载目录。它不删除文档、内置权重、其它模型、旧版原生权重提取或 OpenVINO 编译缓存。已在内存中的推理会话仍按现有闲置策略释放；不要将磁盘删除当作瞬间释放全部内存。原生模型仍在使用前核对其固定权重。

下载位置：Electron 用户数据目录下 `model-library/v1/<模型 ID>/<固定版本>/`。浏览器开发预览只展示清单；桌面下载文件通过本机协议提供给 WASM，OpenVINO 服务直接复用同一副本。桌面 Transformers/Tesseract 不再为新使用的文件另建浏览器模型缓存，避免重复占用及删除后读到旧副本。

## 模型与许可来源

- Texo：固定 FormulaNet 版本的模型卡声明 AGPL-3.0；代码见 [Texo](https://github.com/alephpi/Texo)，权重见 [固定模型卡](https://huggingface.co/alephpi/FormulaNet/blob/b2668efe5112082846fde4d446b9bfaab3989533/README.md)。
- OPUS：固定 Xenova ONNX 英中/中英转换；上游 [英中 OPUS-MT](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) 标记 Apache-2.0。
- Tesseract：固定 [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) 中英权重，Apache-2.0。
- PP-OCRv4：固定 RapidOCR 3.10.0 转换，上游 [RapidOCR](https://github.com/RapidAI/RapidOCR)/PaddleOCR；原始 NOTICE 和许可保留在完整包。
- Piper：不能将推理库的开源许可视为声音及训练数据许可。[Lessac MODEL_CARD](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/lessac/low/MODEL_CARD) 指向 Lessac 数据条款；[Huayan MODEL_CARD](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/zh/zh_CN/huayan/x_low/MODEL_CARD) 将数据许可列为 Unknown。管理页明确展示这一区别，后续声音许可核验仍保留。
- Piper phonemizer 包含 eSpeak NG；[WASM 构建来源](https://github.com/diffusionstudio/piper-wasm) 记录组件链，不能仅凭 npm 包装层推断整个二进制都是 MIT。

CPU/WASM 为基础离线实现。Texo/PP-OCR/Piper 原生 AUTO 路由优先尝试 NPU，再 GPU、CPU；OPUS 原生仍需手动启用实验模式。可选 OpenVINO 运行时需单独安装，模型下载不会安装 Python 或驱动，也不保证每个算子均运行于 NPU。

0.2.17 已统一 Provider 任务接口；0.2.18 在任务面板提供闲置模型内存释放、与新原生服务协同切换、免推理翻译保留热模型和非轮询闲置释放。内存释放入口不会删除磁盘文件，详见 [任务与资源生命周期](PROVIDER-TASKS.md)。

仍待继续：多语言/更多声音、声音条款核验、更大真实质量样本及真机功耗/笔延迟。

## 0.2.20 磁盘缓存

设置 → 磁盘缓存管理。打开时不统计；点击“统计缓存”才枚举目录、文件大小和响应头，不读权重内容、不加载模型、不后台轮询。浏览器 OCR 大小及缺少 Content-Length 的缓存条目标记为未知，显示已知大小下限，并非实际磁盘占用量。清理每一类都需确认，取消排队或关闭窗口会中止未执行任务；已经删除的文件不会恢复。

原生仅允许 `%LOCALAPPDATA%/SurfaceTab` 下固定五类：`openvino-cache`、`opus-openvino-cache`、`ocr-openvino-cache`、`piper-openvino-cache`、`native-models`。编译类别只识别 blob/cl_cache；解包类别只识别固定模型目录结构。目录链接、异常路径、超过一万项或统计后的文件变化会拒绝清理。清理已识别的应用私有编译文件时可移除其只读属性。未知文件、空目录、下载库、运行时、文档以及所有自定义缓存路径保留；此前拒绝清理的开发实验缓存不属于这些目录，不进行操作。

更新后的四个原生模型在构造前持有共享 OS 文件句柄，并一直保留到模型对象释放。清理助手需取得独占句柄，正在使用的另一原生进程会使清理返回忙碌；清理期间新构造返回 429，不另启 WASM。默认 8766 服务必须声明 cache-lease-v1，清理前仅释放闲置模型，旧版或不明服务拒绝清理。没有默认服务时仍需通过独占句柄检查。旧版手动服务/其它端口的旧程序不参与保护，因此必须先关闭；这不是对任意第三方进程的全局锁。

浏览器模型任务使用同来源共享 Web Lock，清理经本地任务队列和独占 Web Lock 执行。只删除专用 transformers-cache；Tesseract 的 keyval-store/keyval 只删除四种已知中英 traineddata 键，保留旧笔记及其它键；OPFS 的 piper 只删除中英两声音的 onnx/json 四个文件，保留未知文件和其它目录。其它窗口的闲置浏览器模型可能仍在内存中，磁盘回收不代表释放所有窗口内存；下一次冷加载可能需要下载副本。

桌面助手是按需启动并隐藏的 PowerShell 子进程，最长 30 秒；主进程校验请求来源和固定类别/统计令牌，取消、主页面导航、退出时终止拥有的任务，不接受 renderer 提供路径。浏览器预览仅操作当前来源的浏览器缓存。跨进程/保留数据验证只在隔离临时目录中删除测试文件，真实缓存仅做元数据读取。
