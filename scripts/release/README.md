# 安装包制作

先在仓库根目录运行 `pnpm build`，再按需要选择一种打包方式。生成物写入指定输出路径，不放进 `scripts`。

| 入口 | 产物 / 用途 |
| --- | --- |
| `source.py OUTPUT.zip` | 源码安装包，带 Mac / Windows 双击入口 |
| `prebuilt.py OUTPUT.zip` | 已构建的通用运行时安装包 |
| `codex.py OUTPUT.zip --platform mac-arm64` | 按系统、芯片区分的 Codex 完整包或精简包 |
| `prepare-codex-runtime.py` | 为 Codex 平台包准备锁定依赖和 Windows Node |
| `prepare-codex-macos-runtime.py` | 补充 macOS 官方 Node 运行时 |
| `codex-bootstrap.py CATALOG.json OUTPUT_DIR --version N` | 从校验后的平台目录生成在线安装引导脚本 |
| `codex-macos.py` | 从已有 Codex 包派生 Mac 专用包 |
| `codex-online-payload.py` | 从完整包派生在线下载载荷 |
| `codex-single-file.py`、`codex-windows-launcher.py` | 为已制作的载荷生成单文件 / Windows 启动包装 |

后四项用于派生已有包，普通安装不需要运行。参数详见对应文件的命令行说明或文件头。

`templates/` 存放生成用 `.in` 模板；`resources/` 存放 Codex 专用依赖清单、锁文件及包内说明。详细的平台包说明见 [resources/codex-readme.md](resources/codex-readme.md)。
