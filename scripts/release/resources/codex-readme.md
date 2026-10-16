# 网页助手（Tandix）Codex 版

完整 ZIP 按 Mac Intel、Mac Apple Silicon、Windows x64、Windows ARM64 分别构建。每包只包含对应平台的安装入口和一种官方 Node.js 24 运行时。Chrome 扩展 `dist/`、连接脚本和锁定 JavaScript 依赖共用构建内容。在线脚本自动识别芯片及 Node 环境，下载匹配的完整包或系统精简包。

安装前，两端都需要 Google Chrome、已安装并登录 ChatGPT 的 Codex。安装器会查找命令行中的 Codex；在 Windows 上还会查找 Codex 桌面客户端放在当前用户目录中的可执行文件。安装器优先复用兼容的 Node.js；完整包自带对应系统和芯片的 Node.js 24 运行时。安装不依赖 npm 包仓库。

1. 完整解压 ZIP。Mac 双击 `安装网页助手-Mac.command`；Windows 双击 `安装网页助手-win.cmd`。不要在 ZIP 预览窗口中运行。
2. 安装窗口会将扩展和连接组件复制到用户目录。按提示在 Chrome 的 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”，选择安装窗口打印的扩展目录。
3. 返回安装窗口继续。脚本尝试自动读取扩展 ID；如果失败，从 Chrome 扩展卡片复制 ID 粘贴到窗口。
4. 在 `chrome://extensions` 重新加载网页助手，打开普通网页的 Tandix 侧栏，连接设置选择 **Codex**，确认显示已连接。

如果 macOS 首次拦截未签名的 `.command`，在尝试打开后前往“系统设置 → 隐私与安全性”，找到这次拦截记录并点“仍要打开”，再确认“打开”。

macOS 使用 Chrome Native Messaging 本机伴随程序按需启动 Codex；Windows 安装时会用系统 PowerShell 5.1 编译一个很小的本机消息代理程序，并在当前用户注册表中注册。两者均在用户目录安装，无需管理员权限。浏览器操作由 Tandix 扩展执行，Codex 通过本地 MCP 工具调用；不会安装 dsh 桥插件。

若 Windows 上 Codex 桌面客户端已启动，但安装器仍找不到可执行文件，可安装官方 Codex CLI，或把可运行的 `codex.exe` 路径放进 `CODEX_CLI_PATH` 环境变量后重试。此包仍需 Chrome 和本机可运行的 Codex；新的统一包仍需在 Windows 真机复测，请先作为内测包发布。

从旧版 ZIP 升级时，完整解压新版 ZIP 并重新双击安装入口即可更新用户目录中的连接脚本和扩展；无需先卸载。Windows v7 会在本机消息代理每次转发后立即刷新输出，修复小消息可能滞留缓冲区、侧栏等待 60 秒后显示“未连接”的问题；扩展在等待本机宿主超时时也会打印明确警告。v6 起会校验并复用一致的已安装 Node 运行时，不再覆盖占用中的旧文件。v4 已修复本机伴随程序加载 Codex 连接模块时的 Windows 盘符路径错误。

## Build platform packages

```bash
python3 scripts/release/codex.py workspace/output/tandix-codex-mac-arm64-v16.zip --platform mac-arm64
python3 scripts/release/codex-bootstrap.py workspace/output/Tandix_v16_release.json workspace/output --version 16
```

Supported platforms: mac-x64, mac-arm64, win-x64, win-arm64, mac-lite, win-lite.
Stage official runtimes and locked dependencies in .build/codex-portable-runtime first.
The release catalog supplies each platform's url, sha256 and local ZIP path.
