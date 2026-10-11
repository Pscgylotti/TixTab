# 后端与 API 配置（0.2.14）

翻译、朗读、OCR 和手写公式分别保存默认后端；同一功能的 Google、HTTP、LLM 等配置相互独立。选择本地后端不会删除已填写的在线设置。改变接口的 origin（协议、主机或端口）时清空该配置的 Key 和自定义请求头，避免沿用旧服务的凭据；同主机下修改接口路径不清空。

## 使用

- 翻译/朗读：选中文字 → 翻译 → 后端设置；朗读配置在“朗读后端”内。
- OCR：框选 OCR → 选择 HTTP OCR API 或图像 LLM API。
- 公式：公式 → 选择 HTTP Formula API 或图像 LLM API；默认仍为本地 Texo。
- “API 高级设置”提供 2–180 秒超时、自定义请求头 JSON、文本流式返回、保存、清除当前后端的 Key/请求头和连接检查。选择 API 后仅在执行任务时发送当前文字或区域图像。

地址可填完整接口 URL。兼容聊天接口也可填根地址或以 `/v1` 结尾的基础地址，应用分别追加 `/v1/chat/completions` 或 `/v1/audio/speech`；已有自定义路径按完整 URL 使用。请填入服务实际支持的模型 ID，不预设付费模型。

“检查连接”仅发送 HEAD，没有选区或请求正文，不启动本地推理。HTTP 405 等返回只证明服务器可达，不能证明 POST 格式、模型和鉴权正确；401/403 显示鉴权错误。需要通过实际功能验证结果。

自定义请求头例如 `{"X-API-Key":"your-key"}`。填写 Key 字段会覆盖 `Authorization` 为 Bearer；Google 使用 `X-Goog-Api-Key`。不要同时在 Key 字段和自定义 Authorization 中配置不同鉴权。Google 官方支持使用请求头携带 Key，应用不再将其拼入查询 URL。参见 [Google Cloud API Key 文档](https://docs.cloud.google.com/docs/authentication/api-keys-use)。

## 接口格式

| 功能 | 普通 HTTP POST 输入 | 普通 HTTP 输出 | LLM 兼容输入/输出 |
| --- | --- | --- | --- |
| 翻译 | `text`、`q`、`source:"auto"`、`target` | `translatedText` 或 `translation` | 文本 messages，`choices[0].message.content` 或 SSE delta |
| OCR | `image`，PNG data URL | `text` 或 `result` | 图像 messages，文本结果或 SSE |
| 公式 | `image`，PNG data URL | `latex` 或 `text` | 图像 messages，LaTeX 结果或 SSE；移除外层代码围栏 |
| 朗读 | `text`、`voice`、`format:"wav"` | `audio/*` 二进制响应 | `model`、`voice`、`input`、`response_format:"wav"`，二进制音频 |

本地 Pix2Text 也使用可配置的公式 HTTP 地址，但仅允许回环主机。其它远程地址请选择 HTTP/LLM 类型。Google 无 Key 时保持官方网站入口，有 Key 时请求 Cloud Translation v2。

桌面版通过主进程 HTTP 中继直接连接接口，无需服务端开放 CORS；浏览器开发预览仍需要接口允许跨域。高级设置会显示当前连接方式。中继使用 [Electron net.fetch](https://www.electronjs.org/docs/latest/api/net)，沿用 Chromium 的代理和证书检查，没有关闭浏览器安全或忽略 TLS 错误。Google 无 Key 的网站入口保持原有行为；有 Key 的 API 与其它三项功能共用中继。LLM 为兼容 Chat Completions 的协议，其它厂商协议/自定义正文映射仍待实现。真实付费服务仍需要用使用者的配置验证，本次没有调用收费接口。

中继只接受受信任主窗口的 HTTP/HTTPS HEAD/POST 请求，不开放本地监听端口。请求不携带浏览器会话 Cookie/Referer，拒绝自动重定向，避免将鉴权送往另一地址。客户端仅在消费响应时读取下一块，每块最多 64KiB、每个任务仅一个在途读取，不定时轮询或预先读完整音频。每窗口最多四个请求、应用实例最多八个；请求正文最多 24MB（UTF-8），响应仍受下面的文本/音频上限约束。超时、用户取消、主页面导航、renderer 退出及窗口关闭均释放连接；活动任务结束即清除截止定时器。

## 保存与回退

桌面端将四项功能的完整配置通过 Electron safeStorage 异步加密写到用户数据目录 `provider-settings.v1.enc`，按 Windows 当前登录用户的 DPAPI 保护。配置文件不放在工作空间工程内；导出 `.surfacetab` 不携带 Key 或请求头。不同 Windows 用户/系统迁移可能无法解密，参见 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

浏览器预览仅持久保存普通元数据；Key、请求头、URL 用户信息与查询参数不写入 localStorage。Key/请求头和 URL 查询参数在完整刷新后需要重填。桌面解密失败时保留原文件、显示错误，避免用空配置覆盖；操作系统加密不可用时不写明文凭据，只保留本次会话。需要恢复损坏配置时，关闭应用后先备份并移走该 `.enc` 文件，再重新配置。

修改后延迟 350ms 合并保存；“保存 API 设置”可立即保存并查看状态。Key/请求头单独变化时不重复写入相同的浏览器元数据。模型不会因保存设置或连接检查而加载。

各 API 有独立的本地回退开关。翻译回到已选的本地 OPUS 路径，OCR 回到已选本地 PP-OCRv4/Tesseract，公式回到 Texo，朗读回到 Piper/系统离线声音。无效地址、请求头或模型输入会直接提示；用户取消不会启动另一份推理。原生模型的忙碌、取消和超时保护继续保留。

文本流解析支持分段 UTF-8、CRLF、SSE 多行事件及结束标记；缺少结束标记/finish_reason 的断连不视为成功。每 100ms 最多推送一次中间文本，最终结果立即显示。文本响应至多 4MB/100,000 字符；音频至多 38,400,044 字节。音频目前合成/下载完再播放，首段流式播放仍待评估。

## 验证

- 单元覆盖配置隔离、跨 origin 凭据清空、普通元数据去敏、请求头和地址校验、Google header、输出上限、流式 UTF-8/断连/取消、文件加密/并发写入/损坏保护以及全尺寸配置重开。
- 浏览器覆盖四项功能的请求、各后端配置恢复、无正文 HEAD、流式结果、关闭/取消不加载模型、夜间竖屏；完整 UI 回归包含本地失败回退及 Piper 中英 WASM。
- `scripts/verify-provider-desktop.mjs` 使用独立临时 profile、真实 safeStorage 和本机 HTTP 测试服务：完整退出重启两次，检查四项配置解密、Key/请求头隔离、真实流式中间值/最终值/取消、音频暂停/继续、图像 OCR/公式输入、导出无凭据、清除某配置后其它配置仍保留。它没有使用真实服务 Key，也没有启动本地模型推理。
- 上述服务刻意不返回 CORS 许可头：先确认浏览器直连失败，再验证四项桌面任务成功、无原生预检、会话 Cookie 不发送。`scripts/verify-relay-desktop.mjs` 另验真实二进制逐字节还原/64KiB 分块、重定向不访问目标、输入/输出上限、等待响应与流式取消、超时、并发限制、刷新清理及不受信窗口拒绝。
- 实际便携 EXE 的报告和构建校验以发布目录 BUILD-INFO.json 为准。硬件功耗、真笔延迟及更大质量集继续保留在计划中。
