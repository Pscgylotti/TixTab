# PDF 元素、便签与页面编辑 / PDF content, reviews and page editing

这些功能收录于 0.3.1；不修改已经发布的 0.3.0 资产。

## 原生元素 / Native content

- 顶部 **PDF 元素 / PDF elements**（D）按需读取当前编辑页的原生文本片段和图片；点击边框进入编辑面板。
- 文本可修改内容、字号、颜色、位置与框大小；图片可移动、调整尺寸、替换或删除。所有修改先暂存，可直接拖动/边角缩放文本和图片并查看真实 PDF 预览。点击“应用 PDF 编辑”后实际更新源 PDF 字节；导出也会将暂存编辑应用到导出副本，旧文字会从原生搜索内容中移除；不是白色覆盖。工程保留其它笔迹、插图及便签。主工具栏撤销/重做会重新加载对应的 PDF 版本。
- Native edits are staged in the project and previewed. Apply PDF edits updates the in-memory source; export applies drafts to the exported copy. Text, font size, color and bounds can be changed; image occurrences can be moved, resized, replaced or deleted. Original source files on disk are not overwritten. Save the project or export a PDF to retain changes outside the workspace.
- 首次使用安装独立 `pdf-runtime`：固定 **PyMuPDF 1.28.2**，复用已管理的 Python 3.10，支持在模型管理中安装。没有模型、GPU/NPU 探测或常驻服务器。每次任务一个低优先级进程，完成、取消或关闭窗口后释放；只向主进程自有的临时目录写入文件，完成后清理。
- 安全边界：当前以原生文本片段和普通轴对齐图片为单位，不提供段落重排或矢量路径编辑。优先复用可用原字体、字号和基线。Type1 拉丁字体保留简单字体/WinAnsi 编码，避免转换成 CIDFontType0 后 PDF.js 字形偏一位。确实缺字时使用同类后备字体并在预览中提示，复杂字体仍需样本核验。斜向/竖排文本、复杂变换图片、同类元素重叠、待应用涂黑批注、禁止修改及签名源文档会拒绝编辑。允许文字超出选框，不自动重排其它元素；暂存无效参数不会应用。
- Hidden OCR text already embedded in an imported PDF is independent content. Moving its image does not semantically regroup or regenerate that hidden text. Complex clipping, transparency groups and unusual fonts need additional real-document coverage; this is a basic native editor, not full Acrobat-style reflow.

## 便签 / Review notes

- 底部 **便签 / Review note**：在页内拖出锚点矩形，随后在页侧输入批注。区域框为圆角、屏幕宽度 1.5 px，缩放时保持视觉粗细；直线连接侧边卡片。悬浮或选择卡片/锚点会同步高亮。
- 单页与连续视图显示页侧卡片；双页默认只保留区域框，悬浮或点击才显示对应便签。卡片固定屏幕尺寸、非编辑时半透明；只在便签工具下选中后显示文本框和控制点。可以拖动卡片到页面两侧，连接线自动选择朝向卡片的一边；卡片可超出纸张，但裁切在阅读区域，不覆盖顶栏等 UI。
- 文字空闲 650 ms 或离开编辑框后提交；工程保存文字和锚点，复制页面重新分配便签 ID，旋转/裁剪同步调整锚点。PDF 导出使用带 Unicode `Contents`、圆角外观及 Popup 的标准 Square 审阅批注，其他支持此批注类型的阅读器可读取文字。多人回复线程尚未实现。

## 页面管理 / Page management

- 缩略图右键或长按菜单新增 **旋转、裁剪、拆分 / 提取**。菜单浮于侧栏外，避免被虚拟列表裁切；原来的长按拖动排序保留。
- 范围可选当前页、全文或 `1-3, 5` 等指定页码。旋转提供逆时针/顺时针按钮和缩略图预览；裁剪可返回目标 PDF 页面框选矩形，随后微调四边 trim 并查看缩略图预览。裁剪按每页当前可见尺寸的百分比设置四边，因此不同尺寸页面能使用同一规则。
- 旋转/裁剪使用短期 Worker，不修改页面稳定 ID、顺序或书签所属页；源 PDF CropBox / Rotate 与前景笔迹、嵌套对象、位图 OCR 坐标投影及便签同步处理。裁剪隐藏边界外内容，不是安全删除。未选中页保持原对象引用，避免重建整个文档的前景。
- 提取所选页为一个 PDF，或每页一个 PDF 并以 ZIP 下载。一次处理一页，ZIP 对已经压缩的 PDF 不再重复压缩。逐页导出固定表单外观并删除无法跨独立文件解析的内部跳转；保留网址和邮件链接。ZIP 总结果限制 256 MB，超过时请按范围分批。

## 混合纸张 / Mixed sizes

三种视图均使用各页可见 CropBox、旋转和 UserUnit 对应的实际尺寸。单页适配当前页；连续视图保留各页比例，Fit width 使用最宽页；双页按两页实际宽度之和及较高页面适配，不强制等宽或等高。不同尺寸页面、裁剪后的页面、空白页可以混排。

## 依赖与许可 / Dependency and license

PyMuPDF / MuPDF: [official project and license](https://github.com/pymupdf/PyMuPDF), [pinned package](https://pypi.org/project/pymupdf/1.28.2/), [editing API](https://pymupdf.readthedocs.io/en/latest/page.html). This optional runtime uses the open-source AGPL v3 distribution, compatible with TixTab's AGPL-3.0-only license. The upstream also offers a separate commercial license; TixTab does not grant that commercial license. Runtime archives retain their upstream licensing information. See the repository LICENSE for AGPL terms.

## 验证 / Validation

真实 PyMuPDF 后端验证旧文本移除、其它内容保留、共享图片单次删除/移动、旋转裁剪坐标、溢出不提交、重叠/待应用涂黑拒绝。浏览器使用真实主进程 PDF 任务模块与子进程，覆盖三种视图的文本/图片编辑与撤销；另测便签创建/高亮/双页显示、混合尺寸、指定范围旋转、全文裁剪、撤销及 ZIP 拆分。未运行应用安装器，也没有重新发布 0.3.0。

## 空白页 / Blank pages

侧栏插入、复制、删除使用同一行图标。插入与删除确认是按钮附近的小窗口，不打开全局遮罩。插入时选择空白、点阵、格子、横线、细密格子及纸张颜色；设置面板不再重复这些选项。工程与 PDF 导出保留颜色/样式，三种视图和夜间模式一致。

本轮增加原字体/实际 PDF.js 渲染回归，包含在 HRESHOLD 后添加 s 的真实 Type1 子集样本。原文件没有覆盖；本地测试副本不进入仓库。

## 图片保存与页面剪贴板（0.3.2）

- OCR 截图预览在复制左侧提供下载 PNG；原图窗口右上角下载当前原色/原像素预览，不受夜间调暗或缩放影响。
- ChatGPT 左侧“额外工具 → 提取图片”支持当前页、全文或指定页，选择目标目录后按顺序保存 PNG。含嵌入及插入的位图，不重复导出草图/公式。重名自动加序号，不覆盖旧文件；异常/超过 6400 万像素的图片会统计为跳过。中止保留已写入文件。
- 页面侧栏新增复制到剪贴板与粘贴页面；也可用缩略图右键/长按菜单，聚焦缩略图时 Ctrl+C，切换文档后 Ctrl+V 或点击粘贴页面。插入当前页之后，保留页面尺寸、源 PDF、笔迹、可编辑对象、便签及 OCR 元数据，可撤销。原有“复制当前页”仍直接在同一文档中复制。
- 页面剪贴板只属于当前应用窗口会话，可跨文档标签；不支持把页面粘贴到其它应用或跨重启。系统剪贴板仅存短标记，页面源数据只留一份独立页面，最多 64 MiB；右键菜单可清空。修改中的原 PDF 内容需先应用/放弃。跨页内部目标不随页面复制，网址保留，表单保留静态外观。
- 页面处理使用可取消的短期 worker，完成/异常/关闭时终止；位图批量导出先索引后逐张解码，完成一张清理解码器缓存/画布并关闭位图，结束销毁专用 PDF worker。下载 URL 限两项且十秒自动回收。
- 撤销历史按唯一 PDF 源缓冲区收费，共享同一源的笔迹编辑不会重复计入。额外源数据预算普通 200 MiB、节能/电池自动模式 120 MiB、极低内存 32 MiB；至少保留最近一步撤销，因此单个超大源仍可能超过预算。这是数据保留上限，不是整机内存或峰值分配承诺。
