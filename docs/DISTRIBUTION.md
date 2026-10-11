# Distribution and licenses / 发布与许可

SurfaceTab application code is licensed under **AGPL-3.0-only**; see the root LICENSE. Copyright © 2026 SurfaceTab contributors. Preserve the license and notices when redistributing. Modified distributions must meet AGPL source-availability obligations, including applicable network-use obligations. Source for v0.2.35 is available at https://github.com/Pscgylotti/SurfaceTab/tree/v0.2.35.

SurfaceTab 应用代码采用 **AGPL-3.0-only**。再分发须保留许可、版权及第三方声明，并按 AGPL 提供相应源码；修改版本及适用的网络使用场景也须履行协议义务。第三方组件和模型保留各自协议，不能仅凭应用协议判断模型可否商用。

## First public release

- **Only the lite x64 portable executable is publicly distributed.** It contains no neural model weights or Piper phonemizer WASM/data files. Models are optional downloads from their pinned upstream sources; read the model terms before downloading or redistributing them.
- The existing full/offline local prototype is not part of this public release. In particular, `zh_CN-huayan-x_low` reports an **Unknown** dataset license in its model card. This release does not claim permission to redistribute that voice.
- Texo / FormulaNet: upstream AGPL-3.0 attribution retained; see https://github.com/alephpi/Texo and the model catalog.
- SenseVoice weights: **FunASR Model Open Source License Agreement 1.1**, not simply the Apache license of its inference code. See SENSEVOICE-MODEL-LICENSE.txt. Whisper weights and Sherpa inference code have separate notices in this directory.
- Piper browser wrapper: `@mintplex-labs/piper-tts-web@1.0.5`, MIT. SurfaceTab's modifications are reproducible in `scripts/prepare-runtime.mjs`: local resource URLs, one WASM thread, phoneme mapping and bounded text chunks. The original package is pinned in package-lock.json.
- Optional Piper phonemizer downloads use `@diffusionstudio/piper-wasm@1.0.0`, commit `69522c832bd52d7c16389e9a8aee568065027689`. Its eSpeak-NG component is GPL-3.0; retain ESPEAK-GPL-3.0.txt. Upstream code/build instructions: https://github.com/diffusion-studio/piper-wasm/tree/69522c832bd52d7c16389e9a8aee568065027689 and https://github.com/wide-video/piper-phonemize. Do not redistribute a full phonemizer binary without establishing the exact corresponding source and satisfying its GPL obligations.
- Managed Python is fetched on request from Astral python-build-standalone, pinned to Python 3.10.22 / 20261009 and SHA256. Python/component notices stay in the downloaded distribution. Python and pip dependencies are not bundled in the release executable.
- NPM dependency versions, sources and license texts are recorded in THIRD_PARTY_NOTICES.md, docs/THIRD-PARTY-LICENSES.txt and package-lock.json. Electron's own LICENSE and Chromium notices accompany the extracted executable. Pinyin engine/dictionary notices are separate in this directory.

首个公开版本只发布轻量包，不捆绑模型权重或 Piper 音素二进制数据。中文 Huayan 声音的再分发许可尚未明确；SenseVoice 模型使用独立的 FunASR 条款。按需下载不等于授予商用或再分发权利，请以各模型原始协议为准。

## Build and publication

Use Node.js 22.17+ and `npm ci`, then `npm run pack:release`. The published portable is unsigned and does not install a background service. Windows SmartScreen may show a reputation warning. Only use builds from this repository's Releases page and compare SHA256SUMS.txt.

仅支持已验证的 Windows 11 x64 路径；ARM64、高通 NPU、其他 Surface 型号与实际笔硬件组合仍待验证。便携程序无代码签名，首次运行可能显示 SmartScreen 提示。发布时应同时提供对应源码、许可证、第三方说明和 SHA256 校验值。
