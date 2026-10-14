# Performance evidence

The checked-in reports and hash manifests document both retained and withdrawn experiments. They are specific to their frozen sources and synthetic workloads; they do not establish battery-life gains or performance on every device.

Large raw payloads (compressed traces, screenshots, source snapshots, input/output artifacts and content-addressed blobs) are preserved in the maintainer's local validation archive, and are excluded from Git and the application installer. Reports below may link to these local payload paths. Their manifests describe the complete original archives; archive-verification scripts require those payloads in addition to this checkout. Do not mistake a manifest-only checkout for an independently verified raw archive.

The runnable benchmark/fixture generators remain in `scripts/`. See [the milestone](../MILESTONE-0.3.0.md) and [validation](../VALIDATION.md) for the scope and limitations of current verification. Later performance comparisons use one A/B per candidate/workload as requested, rather than repeatedly averaging runs.

中文：仓库保留报告、源码工具与完整哈希清单；约 3 GB 的原始载荷保存在本机验证归档，不进入 Git 或安装包。报告中的原始载荷链接需要该归档。没有原始载荷时不能声称已独立重算。保留及撤回的方案均记录，资源代理不等于真实耗电量。
