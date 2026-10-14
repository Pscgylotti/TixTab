# 安装与数据 / Installation and data

0.3.0 的主发布形式为 Windows x64 安装版。

- 运行 `TixTab-<版本>-lite-setup-x64.exe`，默认按当前用户安装，可选择安装目录，也可选择为所有用户安装（需要管理员权限）。
- 自定义安装目录若末尾不是 `TixTab`，会自动补上该文件夹；已有安装沿用原目录时保持不变。安装器创建开始菜单快捷方式、卸载入口；桌面快捷方式在安装完成页可选，默认不勾选。应用设置里的“发送快捷方式到桌面”可随时创建快捷方式。
- 已安装应用启动时直接运行固定目录内的程序，无需每次重新解压。新安装器按固定应用身份检测已有安装，沿用原目录与安装范围，显示已有/目标版本；相同版本提供修复/重装，较旧安装器阻止降级。更新时替换程序文件，保留用户数据；此前便携包没有安装记录，首次运行安装器按新安装处理。当前没有后台自动更新程序。
- 工作空间、设置、账号数据继续使用原应用用户目录；模型、独立 Python 环境及编译缓存沿用原路径，不随安装目录搬移。卸载默认不删除这些数据。移动或卸载程序前，仍建议另存 `.tixtab` 工程。
- 轻量安装包不捆绑神经模型或 Python 运行时；按需下载规则、许可和离线限制与此前相同。安装不创建常驻后台服务。
- 可选便携构建 `TixTab-<版本>-lite-portable-x64.exe` 每次运行解压到临时目录，退出后尝试删除解压内容，异常退出可能留下临时文件。数据目录独立持久保存。便携快捷方式指向原发布包；移动或重命名发布包后需重新创建。
- 安装器与程序未代码签名，下载后请核对发布页的 SHA256。安装包、便携包和源码均须保留对应许可与第三方声明。

The primary 0.3.0 distribution is a Windows x64 installer.

Run `TixTab-<version>-lite-setup-x64.exe`. It defaults to a per-user installation, supports choosing a directory and an optional all-users installation, and creates a Start menu shortcut plus an uninstall entry. Custom directories receive a `TixTab` subfolder unless they already end in that name; upgrades retain an unchanged existing location. The finish page offers an optional desktop shortcut, unchecked by default. Use **Settings → Create desktop shortcut** at any time. Launches run directly from the installed directory. Updates currently require running a newer installer; no background updater or service is installed.

Existing workspace/settings, model downloads, managed Python environments and compiled caches keep their compatible locations outside the installation directory. Uninstalling keeps application data by default. Basic PDF use needs no separate runtime; optional AI setup and licenses are unchanged. The optional portable build extracts on each launch and attempts cleanup on exit. Its shortcut targets the original launcher, so recreate it after moving or renaming that file. Both variants are unsigned; verify the published SHA256.
