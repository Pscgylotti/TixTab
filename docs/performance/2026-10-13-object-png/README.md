# 对象完整编辑流程与异步 PNG 编码

结论：保留异步 PNG 编码以缩短组合对象时的长停顿，不作为节能优化或第二轮整体验收。正式六轮按 A1→B1→B2→A2→A3→B3 运行；A/B 211 份源码/配置仅 `src/objectGroup.ts` 不同。没有降低 SVG、原图、画布像素、压感、PDF 背景或前景导出质量。

## 测量与范围

新增 `--object-editing`，总流程为 15 阶段。实际 UI 框选 240 个对象、移动、角缩放、组合、连续层序上下移、取消组合、撤销/重做、再次组合、保存工程和导出 PDF，再执行书写/尾擦/撤销、连续滚动、双页缩放、日夜切换、公式草稿、空闲和隐藏恢复。导出应用序列化、worker、原生下载完成均计入阶段；输出文件的 Node 读取/哈希和质量解码在测量后进行。合成 pen 事件不代表真笔物理延迟。

素材固定 SHA256 `98c18e6bff9a75000bfc95dd4727cd67020364c364fa2a1357befe714780fe38`，16 页矢量 PDF、第一页 3000 笔、240 个图片/SVG 草图/公式/文本框/嵌套组合。对象全部位于页内；父素材、派生素材、生成器及五份实际测量 harness 归档。草图 scene 为合成数据，不证明真实 Excalidraw 编辑质量。其它页、笔迹原始点和原 PDF 保持一致。组合后尾擦可能删除覆盖大面积页面的顶层组合，两组操作一致；导出发生在此之前。

| 指标（三轮中位数） | 同步 PNG A | 异步 PNG B |
| --- | ---: | ---: |
| 整段 CPU 秒 | 25.769 | 26.130 |
| 整段墙钟秒 | 44.708 | 45.195 |
| 组合/层序 CPU 秒 | 2.083 | 2.128 |
| 组合/层序帧 P95 / P99 ms | 8.5 / 100.0 | 8.5 / 91.6 |
| 组合/层序最大帧间隔 ms | 200.0 | 133.4 |
| 取消组合/撤销/重做最大帧间隔 ms | 149.9 | 99.9 |
| 保存/导出最大帧间隔 ms | 50.0 | 75.0 |
| 200 ms 最大 CPU 需求（核数等效） | 2.922 | 2.855 |
| 1 s 最大 CPU 需求（核数等效） | 2.524 | 2.572 |
| 各进程工作集峰值合计 KiB | 2062904 | 2107156 |

完整阶段统计见 `comparison.md/json`。整段 CPU +1.4%、目标 CPU +2.1%、1 s 需求 +1.9%、工作集峰值约 +2.1%；200 ms 最大需求中位数约 -2.3%，但取值范围重叠且 B 最大单轮更高，不说明所有尖峰降低。移动缩放 P95/P99 接近，取消组合阶段 P99 25.1→33.2 ms，保存/导出最大间隔有所增加。当前后台/温度未严格固定，少量重复不能把所有小差异因果归于编码机制。仅以重复一致的组合长停顿改善保留，后续仍须改进总体资源和剩余 readback。

CPU 是未校准需求代理；缺失 GPU/NPU 活跃、IO、内存传输、唤醒与能量为 null。GPU 进程 CPU 不代表 GPU 设备活跃。采样约 200 ms，不推断 50 ms 需求或瓦数、焦耳、续航。任务完成门槛不是 GPU 栅栏，也不是整机空闲或 60 秒 worker 闲置退出证明。

## 机制与追踪

`canvas.toDataURL('image/png')` 改为等待 `toBlob('image/png')` 后用 FileReader 生成同类型 data URL。原始 SVG、层级、画布大小与 4 倍/8M 像素上限不变；等编码结束才提交，失败保留原对象，期间切页不覆盖新页，finally 释放画布。

单独 trace 与正式跑分分开：相同五文件 harness、相同实际 A/B 构建哈希。A 最大组合主线程根任务 227.115 ms，含 readback 126.137 ms（内嵌 GPU 等待约 111.577 ms）；B 149.399 ms，仍含 readback 108.334 ms（等待约 94.642 ms）。嵌套事件禁止相加。V8 样本估计墙钟包含等待，不当作 CPU。最大 DevTools 消息仅 3568 B，排除之前大文件调试传输的主要工具尖峰；本组不是零采样开销。异步编码没有把 readback 全部搬离主线程，这是下一项候选检查。

## 质量与错误恢复

- 六次实际导出工程均通过冻结生产 model 校验；16 页、3000 笔原始点、其它页、240 个子对象的类型/原图/SVG/scene/公式/文本/嵌套层级及精确仿射变换保持。层序菜单连续点击、取消组合/撤销/重做已由实际 UI 检查；组合的逻辑 inkLayer 为 0。
- 六 PDF 的全部 indirect object 图（包括批注外观 AP、图像、透明遮罩、资源及内容流）忽略创建/修改日期后完全一致。不是仅检查背景 Contents；导出使用原始叶对象，不使用组合父 PNG。
- 父 SVG 字节完全相同。父 PNG 为 1985×2871；A/B 解码直通 alpha 的 680565 个 RGB 通道相差 1，alpha 无差异、8-bit premultiplied RGB 无差异。因此不声称 PNG 字节或原始直通 RGBA 完全相同。
- 取正式 A1/B1 的真实 PNG，在冻结 Electron B 中三种倍率 × 透明/白/夜间背景 × 无滤镜/调暗/反色共 27 项实际绘制 RGBA 严格零差异。各组三轮的 PNG 哈希分别相同，原生检查绑定六轮输出。性能采集中不进行 Canvas 读像素。
- 8 项浏览器通过：原有对象选择/层级测试五项与新增异步栅格/编码失败重试/延迟完成后切页保护三项。3 项 objectGroup 单元及类型检查通过。测试没有验证物理笔延迟或真实 Excalidraw 往返。

最初 pilot 错误地等待 Chromium download 事件而超时，改为观察 Electron session 的原生下载完成事件；失败日志保留，不计入正式六轮。trace 与另一个 B pilot 只作诊断，不合入资源统计；没有排除任何正式轮次。

## 复核与复跑

```powershell
node scripts/verify-object-workflow-archive.mjs --archive docs/performance/2026-10-13-object-png --frozen-prefix .cache/performance-object-png --output .cache/object-png-archive-quality-fresh.json
node scripts/benchmark-workflow.mjs --app-dir .cache/performance-object-png-before --fixture-file .cache/performance-inputs-object-edit/objects.tixtab --object-editing --output .cache/object-png-new-before.json --label new-before
```

第一条重新验证压缩证据、422 份来源、1842 项本机实际运行文件、比较表，再从归档工程/PDF/素材与冻结 model 重新执行几何、元数据和完整 PDF 对象图检查，核对 27 项原生证据与 trace 的来源绑定。输出文件必须不存在；移除 `--frozen-prefix` 时仍可验证归档本体与导出，但不能验证本机冻结运行文件。原生检查可另用 `verify-object-png-native.mjs` 重跑。

大模型、WASM 和未变运行依赖仅保留精确哈希，不重复分发。来源快照和差异运行文件不是独立安装包；完整重建仍需仓库其它共享文件和锁定依赖。测量期间不并行构建/测试/压缩。此实验没有版本提交、GitHub 发布或系统设置变更。0.3.0 的完整素材/交互矩阵、本地 AI 协调与最终包仍未验收。

## 后续 readback 路径：质量门槛拒绝

[HTML 标准](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently)说明 `willReadFrequently` 可让浏览器选择适合像素读取的画布实现。单独对同一大组合 SVG、同一 1985×2871 透明画布尝试该选项，实际 context 属性确认为 true；没有改动生产源码，也没有开始正式资源 A/B。

本机默认画布与该路径输出有 543690 个 alpha 通道不同、最大 alpha 差 121；实际 Electron 27 种倍率/背景/滤镜绘制全部出现差异。因此在质量门槛处拒绝，不以速度或能耗收益接受，不将 SVG 光栅化路径差异称为编码的 1 级舍入。记录的单次墙钟仅用于诊断，不当作 CPU/节能/交互分数。严格原生验证失败日志和另一个独立实际显示检查都保留；生产 211 份来源仍与保留的异步 PNG B 逐项哈希相同。

首次归档核验为 759 份证据、422 份来源、1842 项实际运行文件，六工程/PDF重建与 27 项显示证据绑定通过；追加本次拒绝路径证据后共 769 份，须重新运行验证命令核对完整归档。其它剩余尖峰与能耗专项继续，未宣称完成第二轮或 0.3.0。
