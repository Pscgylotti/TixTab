# 位图文字索引 / Bitmap text index

在“框选 OCR”提示栏点击“解析位图”，默认处理全文，也可指定当前文档的页码（如 `1-3, 5`）。处理 PDF 内嵌位图与插入的图片，包括对象组合中的图片。已有结果默认跳过；设置中可以选择重新识别。

位图解析默认使用本地 Tesseract，并单独记住此窗口的后端选择；也可选 PP-OCRv4/OpenVINO 或 HTTP/LLM API。本地模式不上传图片；远程模式会发送所选范围内的图片。Texo 是公式识别器，不用于此文字索引。窗口显示所选范围的已解析/未解析数量及本批次进度；首张图片准备完成后保持稳定的解析提示，不随每张图片重复显示加载状态。

设置中可选 1、2、4 个并行任务（默认 1），仅 Tesseract 支持；其它后端保持串行。每项输入不超过 400 万像素，并行越多占用内存越大。批次专用 Tesseract 工作线程在完成、取消或失败后释放，用户配置的其它模型闲置卸载时间不变。原始图片与 PDF 不改动；仅文字、引擎名称及归一化行/词坐标随工作区和 `.tixtab` 工程保存。停止后保留已完成的图片（包括组合中已完成的子图片）；失败会显示原因，已完成页面仍可保留。一次批次作为一次可撤销编辑。导出的 PDF 暂不写入该索引，也不生成 PDF 的可选择隐藏文本层。

选文工具也覆盖已解析位图。Tesseract 新结果使用测得的词框，旧的仅有行坐标结果按行布局提供近似字词位置；没有任何坐标的结果只参与检索，不伪造选词位置。选词可复制、翻译或朗读。移动工具下双击 PDF 位图，在“原图”标题旁点击 OCR 按钮查看已保存的文字；无结果与空结果分别提示。

全文搜索包含这些结果。PP-OCRv4 返回检测行的四边形，Tesseract 可返回行框；当前采用完整行框高亮，不根据字数猜测字的位置。图片/组合移动与缩放后，坐标会跟随对象变换。旋转 PDF 图片映射到页面后用轴对齐行外框显示。没有坐标的远程或旧后端结果按整张图片定位。复杂裁剪、遮挡、倾斜或低分辨率图片仍可能识别错误；PDF 图像蒙版不当作普通位图索引。

实测：本地 PP-OCRv4 CPU 英文长行样本返回完整文本及有限、合理的行框；自动测试另外覆盖归一化、旋转/组合变换、范围选择、跳过已有结果、搜索、撤销恢复和工作区持久化。它不是所有文档的精度保证。

## English

Choose **Region OCR → Analyze bitmaps**. The default is the whole document; page ranges such as `1-3, 5` are supported. Embedded PDF pictures and inserted pictures (including grouped objects) are processed with a bounded task pool. Tesseract supports 1 (default), 2 or 4 concurrent workers; other providers remain serial. More workers use more RAM. Existing results are skipped unless replacement is enabled.

Tesseract is the default for bitmap analysis; this dialog remembers its backend selection. PP-OCRv4/OpenVINO, HTTP and LLM providers remain available. Remote providers send the selected pictures. Only recognized text and normalized line/word coordinates are stored; images remain unchanged. Counts and batch progress are shown without repeating model-loading messages per image. Completed work, including children of groups, is kept on stop, and a batch is undoable.

The selection tool uses measured Tesseract word boxes; older line-only results provide approximate glyph positions. Coordinate-free results remain searchable without invented selection boxes. The OCR button beside the original-image title displays stored OCR text.

Measured line bounds are highlighted. Providers without coordinates locate the whole picture. Image/group transforms are respected; rotated line polygons currently use their bounding rectangles. OCR may be inaccurate. Metadata is saved in `.tixtab` projects, not embedded as a searchable text layer in exported PDFs.

References: [RapidOCR output](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/), pinned Tesseract.js 7.0.0 `worker-script/utils/dump.js` (`blocks` output).

## 索引与解码内存 / Index and decode memory

全文统计使用固定 PDF.js 5.4.624 的构建扩展，只解析图片出现位置、变换和索引，不解码位图、不加载字体。升级 PDF.js 时构建会拒绝未经核对的版本或补丁锚点。正文渲染仍走上游路径。

扫描 PDF 图片使用独立的短期 PDF worker，与阅读器的文档、解码图片和字体缓存隔离；解码/清理串行，OCR 可并行。每项绘制完清理 PDF 页面/公共图片缓存，识别后画布缩至 1×1；批次结束或停止后销毁专用 PDF worker 和 Tesseract workers。PDF.js 在读取目标图片时仍可能解析该页其它图片，峰值受当页内容影响；不是按文件大小保证固定 RAM。保留的文字/坐标索引会随已识别内容增长，进程已释放的堆内存也不保证立即返还系统。

Indexing returns geometry only, without image/font messages. A separate temporary PDF worker owns scan-time decoding and is destroyed at batch end. Decode/cache cleanup is serialized while recognition remains parallel. Reader caches are not populated by scans. Saved OCR text/geometry intentionally remains in the workspace.

## 后续模型验证 / Model evaluation queue

新增可选 **Tesseract · NPU · 实验性**，英文 Best（默认）/Fast 和 **简体中文 + English · 混合 Best**。16 行有界队列；英文最大 batch 1/2/4，混合模式暂固定单行 NPU 推理。CPU 只负责分行和前后处理，NPU 失败不回退。混合模式另需安装 **Tesseract 中英混合 Best**，仍有空格遗漏等实验性限制。安装、资源生命周期、已知精度限制见 [Tesseract OpenVINO](TESSERACT-OPENVINO.md)。原 CPU Tesseract 中英支持及默认选择不变。

Optional **Tesseract · NPU · Experimental** offers English Best (default), Fast, and **Simplified Chinese + English · Mixed Best**. A 16-line queue is bounded; English supports maximum batches 1/2/4, while mixed mode currently uses single-line NPU inference. CPU handles layout/pre/postprocessing, with explicit NPU errors. Install the separate mixed Best model. Spacing errors remain an experimental limitation. The existing bilingual CPU default is unchanged.

CPU 1/2/4 现在表示最大并发数量，活动输入另受 400 万像素总预算限制；大图自动减少并发，空闲 worker 共享/高水位回收。停止立即终止专用扫描 PDF worker，并取消加载/绘图/清理等待；完成结果保留。此预算不是整个进程内存上限。详情中可查看分行/推理/编译/服务累计计时，不能直接当作整批墙钟时间或能耗证据。

2026-10-14 单次实际运行验证：当前浏览器能取得非软件回退的 Intel Xe-2LPG WebGPU adapter，OpenVINO 同时枚举到 Arc 130V GPU。向本地 Tesseract provider 指定 GPU 后，实际结果仍标记 CPU (WASM)，加载 tesseract-core-relaxedsimd-lstm.wasm.js；英文样本完整返回。一次含初始化耗时约 394 ms，仅验证执行路径，不是 GPU 推理或加速比。复现：tests/tesseract-backend-capability.spec.ts；本地记录：.cache/tesseract-gpu-check/result.json。当前缺少 Tesseract LSTM 的 GPU 执行实现，不能将旧 OpenCL legacy 支持当作可用的同模型 GPU 后端。

- 英文论文：验证 en_PP-OCRv5_mobile_rec，分别记录漏行、字符错误、空格与段落顺序；不能只比较平均置信度。
- 对照 Tesseract.js、当前中英 PP-OCRv4，记录冷启动、热推理、det/rec/后处理耗时及内存；每个工作负载一次对照，不推断能耗。
- Intel GPU/NPU 需要分别验证 OpenVINO 导出、算子、固定尺寸与实际设备执行。上游 NVIDIA GPU 或 Xeon CPU 数字不能当作当前设备证据。
- PP-OCRv6 tiny/small 可作为候选；tiny 的体积/速度取向不等同最佳准确率，不能未经样本测试默认替换。
