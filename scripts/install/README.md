# 安装脚本

通常双击仓库根目录的中文安装入口即可；下面是需要从终端执行或维护安装器时的对应关系。

| 文件 | 用途 |
| --- | --- |
| `windows.ps1` | Windows 完整安装向导，检测依赖、构建、注册并检查连接 |
| `macos.sh` | macOS 免 clone 安装入口 |
| `source-unix.sh`、`source-windows.ps1` | 源码下载、依赖安装、构建及 dsh profile 注册，由向导调用 |
| `codex.mjs` | 预构建 Codex 包的安装和本机伴随程序注册 |
| `node-macos.sh`、`node-windows.ps1` | 为 Codex 安装包准备经过校验的 Node 运行时 |
| `codex-windows-host.ps1` | 编译 Windows 本机消息代理 |
| `open-chrome-windows.ps1` | 打开 Chrome 扩展管理页面 |
| `start-dsh-windows.ps1`、`run-dsh-windows.ps1` | 保留的独立 dsh 启动辅助程序；完整向导使用按需启动的本机伴随程序 |

Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/windows.ps1`。

macOS：`bash scripts/install/macos.sh`。当前 macOS 源码入口需要已有 Chrome 和兼容 Node/npm，具体要求见根目录安装说明。
