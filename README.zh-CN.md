# TixTab

**Thinking over Screen** — 面向 Windows 和 Surface 手写笔的 PDF 阅读与标注工作空间。

[English](README.md) · [下载](https://github.com/Pscgylotti/TixTab/releases) · [许可证](LICENSE)

## 快速开始

1. 从 Releases 下载 `TixTab-0.2.35-lite-x64.exe`，直接运行。基础 PDF 功能不需要预装 Node.js 或 Python。
2. 打开 PDF，或拖入后选择新标签页打开、插入全部/指定页；拖入图片/SVG 可插为对象。
3. 需要本地 AI 时，进入 **设置 → 本地模型管理**，下载所需模型；点击 **自动安装**，准备独立 Python 和加速/语音运行时。
4. 设置中可切换中英文界面；悬浮键盘包含英文、离线中文拼音、LaTeX 与语音四种模式；语音支持中英文、实时波形和本地引擎，识别文字插入当前光标处。

## 主要功能

- 支持可编辑文本框及智能剪贴板粘贴。在“设置 → 任务与后端”配置模型闲置卸载时间，默认 1800 秒，保留模型文件与编译缓存。文本框在工程内保持可编辑，PDF 导出暂以图片嵌入，不能作为可搜索文字。

- 压感笔迹、尾部橡皮、自定义笔色、对象移动/缩放、框选多个对象，以及可再次编辑的 Excalidraw 草图。
- 在 PDF 上使用笔侧键打开环形工具菜单，切换笔触、移动、选文与对象；选中文字时，中心按钮打开划词操作。侧键需要 Windows 笔驱动提供右键指针事件，通常可按住侧键轻点页面。
- 单页、连续与双页阅读，触屏惯性滚动、页面缩略图与排序、插入空白页、全屏和可收起工具栏。
- 可调渲染清晰度、自动高清补绘与局部高清、实验性 PDF 夜间配色、有上限的缓存。
- Texo 手写公式转 LaTeX、多行公式与常用宏，可选 Uni-MuMER Qwen3-VL-2B。
- 选文复制、翻译、OCR 和朗读，支持本地模型、网页服务和 LLM API。
- 中英文语音输入及录音波形，可选 SenseVoiceSmall、Whisper small 或 Windows 系统识别。
- Zotero 本机资料库联动，以及支持附加页面/原文件的实验性 ChatGPT 阅读助手。

## 注意事项

TixTab 为独立项目，与微软没有官方关联，也未获微软背书；Microsoft Surface 和 Windows 为微软商标。为兼容此前本地预览版，继续使用 `.surfacetab` 工程格式、原应用数据目录与模型缓存。

- **Windows 11 x64 公开预览版。** 已在 Intel Surface Pro 11 商用版、Core Ultra 5 238V 上验证；其它型号、ARM64/高通 NPU 和各种笔硬件组合仍待实测。支持的本地后端可回退 CPU，加速需要兼容驱动。
- **轻量包不含神经模型权重。** 安装需访问 GitHub/PyPI，模型需访问上游站点，请预留数 GB 空间。受限网络下可能下载失败。驱动、Zotero、账号/API Key 和 Windows 语音语言包需另行准备。
- 独立 Python 固定版本并校验 SHA256；环境位于 `%USERPROFILE%\.surfacetab`，不修改 PATH。安装时可取消，关闭安装面板也会取消，重新打开后可重试。
- 本地识别在设备上运行；在线翻译、外部 API 和 ChatGPT 会接收提交内容，发送敏感 PDF 前请确认后端。账号聊天为实验功能，可用模型和额度由服务端决定。
- 建议同时保存 `.surfacetab` 工程和导出的 PDF。复杂表单、加密/签名 PDF 及特殊文档结构存在限制；编辑会使原数字签名失效。参见 [导出说明](docs/PDF-EXPORT.md)。
- 程序**未代码签名**，SmartScreen 可能提示；请使用本仓库发布包并核对 `SHA256SUMS.txt`。

## 开发与构建

Windows 上安装 Node.js **22.17+**：

```powershell
npm ci
npm start
```

`npm run dev` 启动浏览器开发；桌面调试另设 `SURFACETAB_DEV=1` 后运行 `npm run desktop`。检查命令：`npm test`、`npm run test:e2e`、`npm run format:check`、`npm run build`。`npm run pack:release` 在 `release/<版本>/lite/` 生成公开轻量便携包。

目录：`src/` 界面、PDF 与 Worker；`electron/` 桌面桥接、下载与安装；`backend/` 可选 Python 后端；`scripts/` 准备/验证；`tests/` 浏览器回归；`docs/` 功能和许可。[自动安装](docs/RUNTIME-SETUP.md) · [历史记录](docs/CHANGELOG.zh-CN.md)。

## 许可

应用代码采用 **AGPL-3.0-only**，第三方代码与模型保留原协议。公开轻量包不带模型权重，也不分发数据许可尚不明确的 Huayan 中文声音。按需下载不等于获得商用或再分发许可。详见 [发布与许可](docs/DISTRIBUTION.md)、[模型条款](docs/MODELS.md) 和 [第三方清单](THIRD_PARTY_NOTICES.md)。

拖入 PDF 会询问：新标签页打开，或在当前页之后插入全部/指定页面（例如 `1-3, 5`）。拖入 PNG/JPG/WebP/GIF/BMP/AVIF/SVG 则插为图片对象。ChatGPT 助手可切换到独立 Windows 悬浮窗，并根据描述生成 SVG、预览后插入页面。SVG 会移除脚本和外部资源引用，界面保留矢量显示，导出 PDF 使用有像素上限的高清 PNG；动图插入静态帧。合并 PDF 会使原签名失效，导入页的表单转为静态外观。
