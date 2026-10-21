# TixTab

**Thinking over Screen** — a pen-first PDF reading and annotation workspace for Windows.

Supports Surface Pen.

[简体中文](README.zh-CN.md) · [Download](https://github.com/Pscgylotti/TixTab/releases) · [License](LICENSE)

## Get started

1. Use the Windows installer `TixTab-0.3.8-lite-setup-x64.exe`, then launch TixTab from the desktop or Start menu. Basic PDF features need no Node.js or Python. The installer supports upgrading an existing installation and an optional desktop shortcut on its finish page.
2. Open PDFs in tabs, or drop a PDF and choose to open it in new tabs or insert all/selected pages after the current page. Drop PNG/JPEG/WebP/GIF/BMP/AVIF/SVG files to insert image objects.
3. For local AI, open **Settings → Local model library**, download the models you need, and click **Set up** to prepare managed Python and optional acceleration/speech dependencies.
4. Switch the interface language in Settings. English, offline Chinese Pinyin, LaTeX and voice keyboard modes are included. The compact key layout includes Ctrl, Tab and Esc; tap Ctrl then A/X/C/V/Z/Y to edit. Voice input supports Chinese/English, a live waveform and local engines, and inserts at the current text caret.

## Features

- First launch selects the first supported system language (Chinese or English), with English as the fallback. A saved manual language choice takes priority.
- Presentation fullscreen hides the editor UI in all three layouts, centers fitted pages and preserves zoom and score auto-turning. Touchscreen swipes and horizontal trackpad gestures turn single pages/spreads; double-click exits.
- Optional Windows AI Speech (experimental, local) and Windows SDK Speech (may use online services), with microphone level meters. Windows manages the AI model; first compilation can be slow, and resident models follow the configured idle-unload time. Opt-in Surface Pen tail controls: single-click starts/stops dictation, double-click stops and sends.
- Downloads and document processing can continue behind a compact progress dock. Physical keyboard input hides the floating keyboard. Untouched blank documents stay out of the workspace; Markdown supports strikethrough.

- Sequential review opens a PDF folder in one tab, loads files on demand, preserves individual edits, and exports edited PDFs to a chosen folder without overwriting originals. Its compact floating navigator can be dragged across the application window.
- Select multiple sidebar pages with keyboard, mouse or touch, including select all/none/invert, and copy/paste them across documents as one undoable batch.
- Preview and paste session clipboard history: text, images, editable objects and ink. The data budget is 128 MiB, or 32 MiB in minimal-memory mode, without an item-count limit. Pause or clear history when handling sensitive content; previous Windows Win+V history is not imported. TixTab runs as a single instance.

- Save captures/original images as PNG, extract document bitmaps to a folder, and copy/paste editable pages between documents with bounded clipboard/source history.
- Settings include overall UI scaling (0.5–4.0; baseline 2.0) and a piecewise pen-pressure curve with up to 16 internal points.
- Experimental queued NPU bitmap OCR offers English Best/Fast and mixed Simplified Chinese/English Best. The CPU default remains; large CPU inputs share a pixel budget, and stopping releases scan workers. NPU is not guaranteed faster, and mixed spacing errors remain. [Setup and limits](docs/TESSERACT-OPENVINO.md).

- Drag document tabs to reorder; long-press or right-click for close/current/other/right actions. Touch users can drag after holding. Tab order persists, and closing preserves workspace documents.
- Basic native PDF text/image editing with real previews, region review notes, rotate/crop/split, an extreme memory mode, and lightweight bitmap OCR indexing. [Editing scope and limits](docs/PDF-EDITING.md).

- Bitmap text indexing: choose **Region OCR → Analyze bitmaps**, then the whole document or a page range. Recognizes embedded/inserted pictures locally, saves text metadata in `.tixtab`, and includes it in document search with measured line highlights. Remote OCR is optional. [Details and limits](docs/BITMAP-OCR.md).
- While using a drawing pen, hold its side button and drag to select handwriting; mouse users can hold Alt. A transparent selection frame supports move, cut/copy/paste and undo. Side-button taps still activate highlighted images/links or open the tool ring on empty space. Hovered targets have a separate emphasis color.
- Click the bottom page number to jump: mouse/keyboard use a text field, pen/touch use a numeric pad. Document switches actively retire PDF/thumbnail raster caches; visible images stay intact until their display is unmounted.

- Document search, PDF outline, bookmarks that follow page order, reference/web links with navigation history, and duplicate page. Resize the sidebar; its PDF previews have a separate 150-image LRU. Hover over search results for highlighted context. Bookmarks persist in projects and exported PDFs; the LaTeX editor has independent undo/redo. [Scope and limitations](docs/DOCUMENT-NAVIGATION.md).

- Editable text boxes and smart clipboard paste are supported. Model idle unloading is configurable in Settings → Tasks and backends (default: 1800 seconds); weights and compiled caches are kept. Text boxes remain editable in projects, but PDF exports currently embed them as images rather than searchable text.

- Pressure-sensitive ink, pen eraser, custom colors, object selection/movement/resizing, multi-object selection and editable Excalidraw sketches.
- With the Object tool, cut/copy/paste single or multiple objects using Ctrl+X/C/V, including between pages and documents. Editable sketches, formulas/macros and text boxes are preserved. Use Arrange objects for front/back and one-layer moves; Ctrl+[/] moves one layer, Ctrl+Shift+[/] moves to the back/front. Clipboard and ordering edits support undo/redo.
- All handwriting on a page shares one sortable layer. Select Handwriting layer with the Object tool to move it; inserted objects can be above or below the handwriting. The order is retained in projects, thumbnails, PDF export, captures and chat image attachments.
- Hold the pen side button to highlight images, links and references on the current page, then tap to interact with any tool. Tap elsewhere to open the radial menu. This needs side-button reports within the digitizer's sensing range. With the Move tool, double-tap an image in either theme to open a zoomable, pannable preview using embedded source pixels when available.
- Direct ink and object editing in single, continuous and two-page views, inertial touch scrolling, page thumbnails/reordering, blank pages, fullscreen and collapsible controls.
- Configurable rendering clarity, automatic detail rendering, experimental PDF night colors and bounded caches.
- Texo formula-to-LaTeX, multiline formulas and saved macros; optional Uni-MuMER Qwen3-VL-2B backend. Recognize and replace, or insert incrementally at a persistent caret. Handwriting, LaTeX source, caret and multiline options are saved locally per document/formula object and restored after closing or restarting. These drafts are not included in exported project files.
- Move/resize multiple objects together and create nested groups with a hierarchy preview. Ungroup one level while keeping inner groups intact; SVG display and PDF export retain original child detail. Up to 8 levels and 1,000 child objects per group.
- Attach up to three PDF pages to chat, upload standalone images or paste images. Capture an area first, then copy the image or enter OCR.
- Text selection/copy, translation, OCR and TTS; local models plus web/LLM API providers.
- Chinese/English dictation with a waveform: SenseVoiceSmall, Whisper small or Windows recognition. Choose a microphone in Voice settings; the saved selection is shared by all three engines.
- Zotero local-library integration and an experimental reading assistant with ChatGPT account or OpenAI-compatible LLM API mode, page/file attachments, a detachable native window, and SVG generation/preview/insertion. API usage is billed separately; configure it under Account and model.

## Notes

Editable projects use the `.tixtab` extension. Earlier project contents are unchanged; rename their extension to `.tixtab` before opening. The existing profile folder and model caches remain compatible.

- **Windows 11 x64 public preview.** Tested on a Core Ultra 5 238V device. Other devices, ARM64/Qualcomm NPU and real pen/device combinations are not fully validated. Supported local backends offer CPU fallback; acceleration needs compatible drivers.
- **Lite: neural weights are not bundled.** Setup needs GitHub/PyPI access; models need their upstream hosts. Allow several GB of disk space. Restricted networks may prevent downloads. Drivers, Zotero, accounts, API keys and Windows speech language packs are separate.
- Managed Python is pinned and SHA256-checked. Environments live under `%USERPROFILE%\.surfacetab`; setup does not modify PATH. Click Cancel or close the setup panel to stop; reopen and retry if interrupted.
- Local recognition runs on-device. Online translation, API providers and ChatGPT receive submitted content. Check the provider before sending sensitive PDFs. Account integration is experimental; model access and quota depend on the service.
- SVG imports remove scripts and external resources. Workspace display stays vector-sharp; PDF export uses a bounded high-resolution PNG. Animated images use a static frame. Merging PDFs invalidates existing signatures and flattens imported form fields.
- Save an editable `.tixtab` project alongside exported PDFs. Complex forms, signed/encrypted documents and unusual structures have limitations; editing invalidates existing signatures. See [export notes](docs/PDF-EXPORT.md).
- The executable is **unsigned**; SmartScreen may show a warning. Use the official Releases page and verify `SHA256SUMS.txt`.

## Development

Node.js **22.17+** on Windows:

```powershell
npm ci
npm start
```

`npm run dev` starts browser development; set `SURFACETAB_DEV=1` and separately run `npm run desktop` for desktop development. Checks: `npm test`, `npm run test:e2e`, `npm run format:check`, `npm run build`. `npm run pack:release` produces the lite installer in `release/<version>/lite/`; `npm run pack:portable` produces an optional portable build. [Installation and data](docs/INSTALLATION.md).

Source layout: `src/` UI/PDF/workers; `electron/` desktop bridges/downloads/installers; `backend/` optional Python engines; `scripts/` preparation/verification; `tests/` browser regressions; `docs/` feature notes/licenses. [Runtime setup](docs/RUNTIME-SETUP.md) · [Historical notes](docs/CHANGELOG.zh-CN.md).

## Contributors

- [Pscgylotti](https://github.com/Pscgylotti) — project creator and maintainer.
- [Codex](https://developers.openai.com/codex/) by OpenAI — AI coding assistant contributing to implementation, debugging, tests and documentation.
- [Claude](https://claude.ai/) by Anthropic — AI coding assistant contributing to PDF object editing implementation and auditing.

## License

Application code: **AGPL-3.0-only**. Third-party code and weights retain their own terms. The public lite release excludes model weights, including the Huayan Chinese voice whose dataset redistribution terms are unclear. Optional downloads do not grant commercial or redistribution rights. See [distribution notes](docs/DISTRIBUTION.md), [model terms](docs/MODELS.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
