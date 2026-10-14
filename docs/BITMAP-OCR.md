# 位图文字索引 / Bitmap text index

在“框选 OCR”提示栏点击“解析位图”，默认处理全文，也可指定当前文档的页码（如 `1-3, 5`）。处理 PDF 内嵌位图与插入的图片，包括对象组合中的图片。已有结果默认跳过；设置中可以选择重新识别。

识别沿用 OCR 后端设置，优先本地 PP-OCRv4/OpenVINO，无法使用时回退本地 Tesseract；也可选 HTTP/LLM API。本地模式不上传图片；远程模式会发送所选范围内的图片。Texo 是公式识别器，不用于此文字索引。

每次只处理一张图片，输入最多约 400 万像素，模型按现有任务通道复用。原始图片与 PDF 不改动；仅文字、引擎名称及归一化行坐标随工作区和 `.tixtab` 工程保存。停止后保留已完成的图片；失败会显示原因，已完成页面仍可保留。一次批次作为一次可撤销编辑。导出的 PDF 暂不写入该索引，也不生成 PDF 的可选择隐藏文本层。

全文搜索包含这些结果。PP-OCRv4 返回检测行的四边形，Tesseract 可返回行框；当前采用完整行框高亮，不根据字数猜测字的位置。图片/组合移动与缩放后，坐标会跟随对象变换。旋转 PDF 图片映射到页面后用轴对齐行外框显示。没有坐标的远程或旧后端结果按整张图片定位。复杂裁剪、遮挡、倾斜或低分辨率图片仍可能识别错误；PDF 图像蒙版不当作普通位图索引。

实测：本地 PP-OCRv4 CPU 英文长行样本返回完整文本及有限、合理的行框；自动测试另外覆盖归一化、旋转/组合变换、范围选择、跳过已有结果、搜索、撤销恢复和工作区持久化。它不是所有文档的精度保证。

## English

Choose **Region OCR → Analyze bitmaps**. The default is the whole document; page ranges such as `1-3, 5` are supported. Embedded PDF pictures and inserted pictures (including grouped objects) are processed sequentially. Existing results are skipped unless replacement is enabled.

Local PP-OCRv4/OpenVINO is preferred, with Tesseract fallback. HTTP and LLM providers use the configured remote endpoint and send the selected pictures. Only recognized text and normalized line coordinates are stored; images remain unchanged. Metadata survives workspace/project restoration and participates in document search. Completed work is kept on stop, and a batch is undoable.

Measured line bounds are highlighted. Providers without coordinates locate the whole picture. Image/group transforms are respected; rotated line polygons currently use their bounding rectangles. OCR may be inaccurate. Metadata is saved in `.tixtab` projects, not embedded as a searchable text layer in exported PDFs.

References: [RapidOCR output](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/), pinned Tesseract.js 7.0.0 `worker-script/utils/dump.js` (`blocks` output).
