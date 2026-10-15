# Windows AI OCR backend

The optional `windows-ai` provider uses `Microsoft.Windows.AI.Imaging.TextRecognizer`, not the legacy Windows.Media.Ocr engine. It is selectable in region OCR and bitmap analysis. System model readiness/creation occurs on demand in an isolated console process. A bitmap scan shares one recognizer and processes images serially. Input PNGs are bounded to four million pixels, removed after each request, and all process/model handles are released on completion, failure, cancellation or renderer shutdown. No system model is loaded at ordinary TixTab startup. Windows may retain shared model-service caches independently; closing the helper releases TixTab-owned allocations and handles, not OS-managed caches.

Results retain line and word quadrilaterals in source image pixels; the existing bitmap annotation normalization supplies searchable OCR and highlights. Empty/null `RecognizedText.Lines` and null word collections are valid empty results. They must not be passed directly to LINQ: doing so raises `ArgumentNullException` with HRESULT `0x80004003`. This failure was reproduced with a blank bitmap and fixed. Actual validation on the current host: readiness `Ready`; blank 1000×1000 → 0 lines, followed by 1600×2400 printed fixture → 50 lines, in the same recognizer. This is a smoke test, not an accuracy or performance comparison.

## Application identity and consent

The helper embeds matching `msix` identity metadata. Its identity package declares `systemAIModels`, `runFullTrust`, `AllowExternalContent` and `MaxVersionTested=10.0.26226.0`. The existing NSIS app remains unpackaged; only the OCR helper receives package identity. Local development registration has been verified with the host's already-enabled Developer Mode. No security policy, administrator elevation or trusted certificate store was changed. The missing identity originally produced `0x80070005`; registered identity changed readiness to `Ready`.

This is not an ordinary per-request privacy permission dialog. A signed identity package can be registered by the installer; the user can still disable Windows AI in system settings. `EnsureReadyAsync` may need to prepare/download the OS-managed model on first use. Unsupported hardware/OS, disabled AI, missing components and identity errors are reported explicitly. In-app “注册 OCR 组件权限” performs only identity registration, then checks readiness; it never enables Developer Mode or imports a trust certificate.

## Building and distributing

`npm run prepare:windows-ai-ocr` builds a self-contained, trimmed .NET 10 x64 helper from pinned Windows App SDK AI 1.8.79 and Foundation 1.8.260505001 packages. No WinUI shell or Python environment is needed. Output is `.cache/windows-ai-ocr/runtime`; successful builds replace the previous output to avoid stale runtime DLLs. Upstream WinRT libraries currently emit trim-analysis warnings; actual blank/text/layout smoke tests pass. Broader languages and rotated text require checks on supported devices.

For production, set `TIXTAB_WINDOWS_AI_CERT_SHA1` to an installed code-signing certificate whose subject is `CN=TixTab` and is trusted on target machines. The build uses MakeAppx and SignTool to create `TixTab.WindowsAI.Ocr.identity.msix`. `TIXTAB_WINDOWS_SDK_BIN` can override the Windows SDK tools directory. The NSIS hook registers this signed identity package for the current user. A public distribution certificate is still required; no production certificate is present/configured in this experiment. Unsigned loose registration is a development path only and does not make the component deployable on ordinary end-user systems.

For development only, on an already-enabled development machine: `powershell -NoProfile -File scripts/register-windows-ai-ocr.ps1`. `-Unregister` removes this component's registration. Production installers do not invoke this development path.

Only anonymous error stage/code/time are written to the component job directory's `last-error.json`. Images, OCR text and document paths are not logged. No packaged Electron app or installer was launched for validation.

References: [OCR API](https://learn.microsoft.com/en-us/windows/ai/apis/text-recognition), [Windows AI setup](https://learn.microsoft.com/en-us/windows/ai/apis/get-started), [identity with external location](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps).
