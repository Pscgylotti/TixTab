# 主要功能差距（2026-10-14）

基于当前源码（含 0.3.0 后本轮改动）与官方功能说明。Drawboard 部分功能需 Pro，Acrobat 的高级能力以 Pro 为参照；这里列的是缺项，不代表这些功能应全部加入轻量阅读器。

| 主要缺项 | TixTab 当前边界 | 主要对照 / 后续优先级建议 |
| --- | --- | --- |
| 完整标准 PDF 批注互操作、批注列表与评论回复 | 已新增区域锚点便签，导出标准 Square/Popup 审阅批注；笔迹和对象可编辑、分组、撤销，但编辑元数据主要存在 `.tixtab`，仍缺少完整批注类型与回复线程 | Drawboard / Acrobat；高 |
| 可填写 PDF 表单、签名管理与证书数字签名 | 可以插入文本与手写签名外观，尚无交互式表单填写、签名模板、证书签署/验证；已有签名失效保护不等于签名功能 | Acrobat；高（表单）、后续（证书） |
| OCR 隐藏文本层写回 PDF | 已能批量位图 OCR、搜索、选词，但识别信息只随工程保存，其他 PDF 阅读器不会获得新 OCR 文本层 | Acrobat；高 |
| 完整原 PDF 正文编辑和版面重排 | 已有基础原生文本片段和普通图片编辑，可替换内容、位置、尺寸及删除；尚无段落重排、原嵌入字体保真及复杂矢量内容编辑 | Acrobat；中，复杂度高 |
| 专业标注和工程测量 | Excalidraw 可绘图，但尚无正文高亮/下划线/删除线批注、批注贴纸库、智能形状/吸附、比例标定和长度/面积/角度测量 | Drawboard；正文批注高，工程工具可选 |
| 多个可命名、隐藏和锁定的图层 | 已有对象前后顺序及整页笔迹层，未提供完整的命名图层管理 | Drawboard；中 |
| 真正涂黑删除、加密权限与敏感数据清理 | 覆盖一个矩形不能删除底下原文；未实现安全 redaction、加密和权限配置 | Drawboard / Acrobat；后续，需可靠 PDF 后端 |
| 格式转换、压缩、文档对比与专业检查 | 无 Office 双向转换、优化压缩、两个 PDF 的差异对比及完整的 PDF/A/可访问性检查流程 | Acrobat，Drawboard 部分转换/压缩；可选 |
| 云同步、多人审阅和跨平台客户端 | 当前工作区以本地为主，Zotero 联动不是协作同步；聊天可浮窗，但未提供完整的独立 PDF 多窗口工作流 | Drawboard / Acrobat；可选，避免默认后台开销 |

搜索、目录、书签、引用/网址跳转、多标签、三种视图、压力笔、夜间模式、OCR、公式、语音与聊天已有实现。本轮又新增旋转/裁剪/按范围提取及逐页拆分界面，不再列作缺项。打印尚未实现，按之前约定暂不推进。

优先补齐阅读批注与 PDF 互操作；工程测量、企业签署与协作不宜默认常驻。新的专业功能宜按需加载或使用可终止的独立任务进程。

官方依据：[Drawboard 功能/方案](https://support.drawboard.com/hc/en-us/articles/4406251856527-Plans-Benefits)、[Drawboard 标注工具](https://support.drawboard.com/hc/en-us/articles/15630133419279-Drawboard-PDF-Using-the-Markup-Toolbar-on-Windows)、[Drawboard Windows 更新及图层](https://support.drawboard.com/hc/en-us/articles/360002397875-Drawboard-PDF-Release-Notes-Windows-app)、[Acrobat 功能](https://www.adobe.com/acrobat/features.html)、[Acrobat 可访问性检查](https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html?screen=modern)、[PDF/A 预检](https://helpx.adobe.com/ca/acrobat/using/preflight-profiles-acrobat-pro.html)。
