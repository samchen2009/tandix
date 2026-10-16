# 脚本入口

普通安装只需仓库根目录的 **`安装网页助手.cmd`（Windows）** 或 **`安装网页助手.command`（macOS）**。不要把下面的辅助脚本逐个运行。

| 目录 | 用途 | 常用入口 |
| --- | --- | --- |
| [install](install/README.md) | 安装向导、源码构建和系统辅助程序 | `windows.ps1`、`macos.sh` |
| [runtime](runtime/README.md) | Chrome 本机伴随程序、Agent 连接和连接诊断 | 安装器自动调用 |
| [release](release/README.md) | 制作源码包、预构建包和 Codex 平台包 | `source.py`、`prebuilt.py`、`codex.py` |
| `cli` | Skill 与聊天活动命令行工具 | `pnpm skill`、`pnpm activity` |
| `dev` | 开发环境和运行时检查 | `pnpm check:runtime`、`pnpm test:smoke` |
| `tests` | 脚本测试和测试样例 | `pnpm test:scripts` |
| `private` | 内部发布隔离工具 | 不进入公开仓库或安装包 |

文件名按职责命名，不再混用 `traceforge-`、`tandix-` 产品前缀。平台统一写作 `windows`、`macos`、`unix`；`.in` 模板和打包依赖清单统一放在 `release/templates`、`release/resources`。

脚本顶层的 `install.sh`、`install.ps1`、`install-macos.sh`、`install-windows.ps1` 仅用于兼容已经发出的下载链接，转交给 `install/` 内的唯一实现。新文档和代码直接使用分类后的路径。
