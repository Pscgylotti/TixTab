# Local runtime setup / 本地环境自动安装

As of **0.2.35**, Settings → Local model library provides on-demand setup for shared OpenVINO acceleration and independent SenseVoice/Whisper recognition. The speech settings button uses the same installer. The desktop path needs **no preinstalled Python or py launcher**. Model weights remain separate downloads.

自 **0.2.35** 起，设置 → 本地模型管理可分别自动安装通用加速环境与语音环境。语音设置使用同一安装器，无需预装 Python。旧版手动 PowerShell 脚本仍可用于开发，不再是使用便携版的必需步骤。

1. Check existing environments and pinned package versions; reuse a ready environment.
2. Download Python **3.10.22**, Astral standalone build **20261009**, to an application-owned directory. Bound download size and verify its fixed SHA256 before extracting with Windows `tar.exe`.
3. Create separate venvs under `%USERPROFILE%\.surfacetab`: `openvino-runtime` and `asr-runtime`. Do not modify PATH or register a system interpreter. Reuse/repair existing environments to the pinned package set.
4. Install binary wheels from bundled requirements, then import backends, check versions and enumerate OpenVINO devices.
5. Show event-driven progress, with no startup downloads or idle polling. Cancellation closes owned processes. A cross-process lock prevents concurrent modifications. Retry reuses prepared Python/venvs and cached pip wheels. Incomplete dependency sets are not marked ready.

Windows x64 only. Setup requires GitHub/PyPI access and several GB of space. Drivers and Windows speech language packs are separate. ARM64/Qualcomm NPU is not validated. GPU/NPU availability is not a guarantee that every model supports the device.

安装支持 Windows x64，需访问 GitHub/PyPI 并预留数 GB 空间。可取消并重试；驱动及 Windows 系统听写语言包另行安装。打开设置不会开始下载模型。

## Validation

On 2026-10-12, a new isolated test directory with no interpreter completed OpenVINO setup in about 75 seconds and speech in about 17 seconds; both enumerated CPU/GPU/NPU. Repeated setup reused ready environments without downloading Python again. This is one device/network measurement. Reproduce with `node scripts/verify-runtime-install.mjs`, which installs into `.cache/runtime-install-validation` rather than existing user environments.

URL, size, SHA256 and revision are fixed in `electron/runtime-manifest.json`. The renderer cannot supply download URLs, shell arguments or paths.
