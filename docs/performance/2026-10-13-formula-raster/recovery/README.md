# 公式画布恢复与多行高度修复

这是增量合成后的正确性补充，不是新的资源 A/B。公式的可见画布或已提交白底画布收到恢复通知时，增量状态失效，按完整保存向量重绘；监听在关闭时释放，不增加空闲轮询。恢复回调通过当前引用读取绘制函数，保留 320/640 当前高度。

初次补充实现的单行恢复通过，但它捕获了初次 320 高度。扩展实际 Electron 用例后，在 640 多行画布恢复时复现下半页丢失，严格差分为 1,228,800 个通道不一致。修改为当前回调引用后，冻结候选 13 项检查全部逐通道零差异，包含两个画布在 320 和 640 高度的恢复、下半区笔迹、追加、取消、重开、删除和清空。两个冻结源快照仅 FormulaDialog 不同。

浏览器 9 项公式回归通过，新增恢复用例在 640 高度下检查可见与已提交画布，原草稿/源码/光标恢复、CPU/GPU 严格像素、多行模拟识别取消及插入位置回归保留。测试通过生命周期事件和擦除像素模拟恢复，不重置物理 GPU；不能据此宣称实际驱动故障验证。首次原生补测工具误将已关闭的画布计入目标，导致歧义错误，诊断日志保留；修正为每次打开限定当前画布后，重新获得上述旧版真实差分失败及新版通过证据。早期 11 项检查未覆盖多行恢复，不作为最终验收。

修正后的实际冻结构建另跑一次完整工作流：11 个阶段、全部已跟踪任务完成与恢复门槛、CPU 区间完整性通过。该单轮仅为集成正确性检查，不与此前不同构建混合为资源收益；原增量合成六轮统计仍对应父目录原始冻结版本。

归档保留 447 份文件，双方完整源快照共 420 项、原始通过/失败日志、浏览器和原生验证源、单轮集成原始报告及全部运行资源哈希。实际冻结资源 614 项及当前生产源文件已复核。公共大体积运行资源不重复打包。

```powershell
node scripts/verify-formula-recovery.mjs --archive docs/performance/2026-10-13-formula-raster/recovery --before .cache/performance-formula-recovery --candidate .cache/performance-formula-recovery-fixed --production
```

重跑原生检查需要新的输出文件名：

```powershell
node scripts/verify-formula-ink-native.mjs --app-dir .cache/performance-formula-recovery-fixed --output .cache/recovery-new.json --recovery
```
