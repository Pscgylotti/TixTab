# Uni-MuMER Qwen3-VL-2B 本机实验（0.2.23）

> 0.2.35 公开轻量版请先在设置 → 本地模型管理中安装通用运行时并下载所需模型，见 [运行时安装](RUNTIME-SETUP.md)。下文保留原开发与基准记录，包内权重等描述适用于当时的完整开发包。公开轻量版不包含模型权重或 Piper 音素二进制，默认可使用系统声音。

启用：设置 → 本地模型管理，分别下载 Uni-MuMER 模型（1481 MiB）和 llama.cpp 运行时（约 32 MiB）；公式窗口选择“Uni-MuMER Qwen3-VL-2B · 本地实验”。可选 GPU、CPU 或自动 GPU → CPU。模型为按需实验资源，完整离线包同样不预装。需要可选 Python 3.10 服务，安装方法仍为 `backend/start-openvino.ps1 -Install`。如端口 8766 已有旧版手动服务，请关闭该旧服务再使用新版本；应用会检测能力并提示。

使用 [官方 Qwen3-VL-2B 微调模型](https://huggingface.co/phxember/Uni-MuMER-Qwen3-VL-2B) 的 [社区 GGUF 量化](https://huggingface.co/mradermacher/Uni-MuMER-Qwen3-VL-2B-GGUF)，语言模型 Q4_K_M、视觉投影 Q8_0。固定版本和 SHA256 见原始报告。主模型与投影共 1,552,465,120 字节，官方原版为 BF16，本次结果不能代替官方评测。官方模型 Apache-2.0、llama.cpp MIT；下载的运行时保留原始许可文件。

## 本机结果

Core Ultra 5 238V / Intel Arc 130V / 32 GiB。GPU 日志确认 29/29 层卸载及视觉编码器使用 Vulkan0。Texo 使用 NPU 编码器和 CPU 解码器，Uni-MuMER 没有 NPU 支持。

输入为 [UniMER-Test](https://huggingface.co/datasets/alephpi/UniMER-Test) 的 HWE 前六张手写样本。比较仅去除 LaTeX 空白，不计算视觉等价、CDM 或全数据集准确率。测试时另有浏览器回归运行，时间只作为本次观测。

| 后端 | 完全匹配 | 首张（含本轮启动） | 后五张中位数 |
| --- | --- | --- | --- |
| Uni-MuMER Q4_K_M / GPU | 2/6 | 5.02 s | 0.77 s |
| Texo / NPU + CPU | 2/6 | 3.06 s | 0.071 s |

六张不能判断总体谁更准，部分符号和数据标签也可能有歧义。当前仍默认 Texo，Uni-MuMER 保留为可切换实验选项。本次没有测量瓦特、续航或真实 Slim Pen 延迟。

实际服务接口还验证了 GPU/CPU 各识别一张、手动释放、缩短期限后的闲置释放、取消正在执行的 GPU 识别；均确认所属子进程退出。推理使用独立回环端口、单任务、2 CPU 解码线程/4 批处理线程、4096 上下文、最多 1024 输出 token，逐行串行复用模型。Windows Job 在服务退出时结束所属模型进程；CPU 回退仅针对本后端自动模式，仍可配置后端不可用时回退 Texo。

## 多行公式

公式窗口勾选“多行手写公式”，在行间留出明显空白，默认按行识别，最多 12 行；分数、上下标、积分上下限尽量贴近所属公式。结果合并为可编辑的 `aligned`，支持预定义命令、预览与插入后重新编辑。取消或中途失败保留识别前的公式，避免覆盖有效结果。

也可选择整体识别。用三张真实手写公式组成的多行图片测试时，Uni-MuMER 整体识别丢失行结构并出现符号错误，因此默认采用逐行模式。自动分行按笔迹垂直间隔分组，复杂矩阵、多层推导或行距太近仍可能误判，可切换整体识别、分批书写或手动修改。

原始结果：[本机测试 JSON](benchmarks/unimumer-qwen3-vl-2b-20261011.json)。官方实现：[Uni-MuMER](https://github.com/BFlameSwift/Uni-MuMER)；推理引擎：[llama.cpp](https://github.com/ggml-org/llama.cpp)。
