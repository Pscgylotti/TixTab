# TixTab

**Thinking over Screen** — a pen-first PDF reading and annotation workspace for Windows.

[简体中文](README.zh-CN.md) · [Download](https://github.com/Pscgylotti/TixTab/releases) · [License](LICENSE)

## Get started

1. Download `TixTab-0.2.38-lite-x64.exe` from Releases and run it. This portable app needs no Node.js or Python for basic PDF features.
2. Open PDFs in tabs, or drop a PDF and choose to open it in new tabs or insert all/selected pages after the current page. Drop PNG/JPEG/WebP/GIF/BMP/AVIF/SVG files to insert image objects.
3. For local AI, open **Settings → Local model library**, download the models you need, and click **Set up** to prepare managed Python and optional acceleration/speech dependencies.
4. Switch the interface language in Settings. English, offline Chinese Pinyin, LaTeX and voice keyboard modes are included. The compact key layout includes Ctrl, Tab and Esc; tap Ctrl then A/X/C/V/Z/Y to edit. Voice input supports Chinese/English, a live waveform and local engines, and inserts at the current text caret.

## Features

- Editable text boxes and smart clipboard paste are supported. Model idle unloading is configurable in Settings → Tasks and backends (default: 1800 seconds); weights and compiled caches are kept. Text boxes remain editable in projects, but PDF exports currently embed them as images rather than searchable text.

- Pressure-sensitive ink, pen eraser, custom colors, object selection/movement/resizing, multi-object selection and editable Excalidraw sketches.
- With the Object tool, cut/copy/paste single or multiple objects using Ctrl+X/C/V, including between pages and documents. Editable sketches, formulas/macros and text boxes are preserved. Use Arrange objects for front/back and one-layer moves; Ctrl+[/] moves one layer, Ctrl+Shift+[/] moves to the back/front. Clipboard and ordering edits support undo/redo.
- All handwriting on a page shares one sortable layer. Select Handwriting layer with the Object tool to move it; inserted objects can be above or below the handwriting. The order is retained in projects, thumbnails, PDF export, captures and chat image attachments.
- Pen barrel button opens a radial tool menu over the PDF; its center opens text actions when text is selected. This needs right-click pointer events from the Windows pen driver, usually by holding the barrel button and tapping the page.
- Direct ink and object editing in single, continuous and two-page views, inertial touch scrolling, page thumbnails/reordering, blank pages, fullscreen and collapsible controls.
- Configurable rendering clarity, automatic detail rendering, experimental PDF night colors and bounded caches.
- Texo formula-to-LaTeX, multiline formulas and saved macros; optional Uni-MuMER Qwen3-VL-2B backend.
- Text selection/copy, translation, OCR and TTS; local models plus web/LLM API providers.
- Chinese/English dictation with a waveform: SenseVoiceSmall, Whisper small or Windows recognition.
- Zotero local-library integration and an experimental reading assistant with ChatGPT account or OpenAI-compatible LLM API mode, page/file attachments, a detachable native window, and SVG generation/preview/insertion. API usage is billed separately; configure it under Account and model.

## Notes

TixTab is an independent project and is not affiliated with or endorsed by Microsoft. Microsoft Surface and Windows are trademarks of Microsoft. Editable projects use the `.tixtab` extension. Earlier project contents are unchanged; rename their extension to `.tixtab` before opening. The existing profile folder and model caches remain compatible.

- **Windows 11 x64 public preview.** Tested on an Intel Surface Pro 11 for Business, Core Ultra 5 238V. Other Surface models, ARM64/Qualcomm NPU and real pen/device combinations are not fully validated. Supported local backends offer CPU fallback; acceleration needs compatible drivers.
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

`npm run dev` starts browser development; set `SURFACETAB_DEV=1` and separately run `npm run desktop` for desktop development. Checks: `npm test`, `npm run test:e2e`, `npm run format:check`, `npm run build`. `npm run pack:release` produces the public lite portable in `release/<version>/lite/`.

Source layout: `src/` UI/PDF/workers; `electron/` desktop bridges/downloads/installers; `backend/` optional Python engines; `scripts/` preparation/verification; `tests/` browser regressions; `docs/` feature notes/licenses. [Runtime setup](docs/RUNTIME-SETUP.md) · [Historical notes](docs/CHANGELOG.zh-CN.md).

## Contributors

- [Pscgylotti](https://github.com/Pscgylotti) — project creator and maintainer.
- [Codex](https://developers.openai.com/codex/) by OpenAI — AI coding assistant contributing to implementation, debugging, tests and documentation.

## License

Application code: **AGPL-3.0-only**. Third-party code and weights retain their own terms. The public lite release excludes model weights, including the Huayan Chinese voice whose dataset redistribution terms are unclear. Optional downloads do not grant commercial or redistribution rights. See [distribution notes](docs/DISTRIBUTION.md), [model terms](docs/MODELS.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
