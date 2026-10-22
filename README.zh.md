# Tandix

让 Agent 在你正在使用的网页上完成任务，并把验证过的流程整理成可复用 Skill。

[English](README.md) | 中文

## 功能

- 在 Chrome 侧栏对话，读取网页、填写表单、切换标签页并完成跨网站操作。
- 连接本地 Codex、Cursor CLI、DeepSeek Harness（dsh）或兼容 ACP 的 WorkBuddy/CodeBuddy 运行时。
- 记录网页操作，与 Agent 讨论流程，再保存、查看和运行 Tandix Skill。
- 查看工具调用、处理授权请求、停止任务和恢复历史。

长历史中的任务关联推断目前是实验性 CLI，尚未接入侧栏自动提炼，见[活动推断说明](docs/activity-inference.md)。

## 命令行安装（源码方式）

脚本已按用途分类，入口与打包工具见 [scripts/README.md](scripts/README.md)。普通安装使用根目录的中文双击入口即可。

**Windows 免命令安装：**下载 [安装网页助手.cmd](https://raw.githubusercontent.com/samchen2009/tandix/main/%E5%AE%89%E8%A3%85%E7%BD%91%E9%A1%B5%E5%8A%A9%E6%89%8B.cmd)，保存后双击即可。如果浏览器显示脚本文本，右键链接选择「链接另存为」，保留 `.cmd` 后缀。只需这一个文件，无需下载整个源码或预装 Node、pnpm、Git。脚本会自动拉取最新安装向导，检测系统架构和已有组件，安装缺失依赖、构建扩展、注册本机伴随程序并检查连接。源码目录内的同名入口优先使用该目录的本地代码。

macOS 先安装 **Google Chrome** 和 **Node.js 22.19+ 或 24+（含 npm）**。Windows 向导会自动准备 Node.js、私有 pnpm 11.7.0、Chrome、dsh、WorkBuddy/CodeBuddy CLI 和 Codex CLI。不需要 Git。安装与依赖下载需要联网；已有兼容运行时和登录配置会保留。

**macOS**，在终端运行：

```bash
curl -fL https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/macos.sh -o install-macos.sh && bash ./install-macos.sh
```

**Windows**，在 PowerShell 5.1 或更高版本运行：

```powershell
$installer = Join-Path $env:TEMP 'tandix-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/windows.ps1' -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

也可以直接下载 [macOS 脚本](scripts/install/macos.sh)或 [Windows 脚本](scripts/install/windows.ps1)，保存后运行。脚本不会全局修改 PowerShell 执行策略。

首次安装时，在 `chrome://extensions` 开启「开发者模式」，选择「加载已解压的扩展程序」，加载脚本打印的目录（默认 `~/.dsh/browser-extension`）。Windows 向导会等待扩展加载、注册本机伴随程序，并实际检查本机消息、WebSocket 和会话列表；WorkBuddy 还会进行 ACP 会话认证检查。账号未登录时，向导会打开对应 CLI，让你完成登录。不会代替你输入账号密码或模型密钥。

Windows 默认准备 Codex、WorkBuddy 和 dsh，并检测已有 Cursor CLI，按 **Codex → Cursor → WorkBuddy → dsh** 的顺序选择首个连接检查通过的 Agent。Cursor CLI 需自行安装并登录。完成后重新加载扩展，在侧栏选择「自动选择」，或手动指定 Agent。dsh 首次使用还需在设置中选择模型并填写自己的凭据。**不需要手动运行 `pnpm start`**。如主要使用 WorkBuddy，在命令末尾加 `-Agent workbuddy`；仅准备 dsh 可加 `-Agents dsh`。macOS 仍按脚本提示完成本机伴随程序注册。

Windows 安装日志和逐项连接报告默认保存在 `%LOCALAPPDATA%\Tandix\install.log`、`%LOCALAPPDATA%\Tandix\install-report.json`。某个 Agent 连接失败时会明确列出原因；所选 Agent 未就绪时安装器返回失败，不会把文件构建完成当成连接成功。Chrome 无法通过系统包管理器自动安装时，向导会打开官方下载页并等待你完成安装。

再次运行入口即可更新托管源码安装；更新后在 Chrome 中重新加载扩展。已有安装目录不由脚本管理时，安装器会停止，避免覆盖。

## 普通用户安装（推荐）

不需要 `git clone`。预构建安装包包含 Chrome 扩展、Node 和连接依赖，不需要 Git、pnpm 或源码编译。

在 [GitHub Releases](https://github.com/samchen2009/tandix/releases) 下载适合电脑的 **完整安装包**：Mac Apple Silicon、Mac Intel、Windows x64 或 Windows ARM64。安装包以 Releases 实际发布的附件为准；仓库的「Download ZIP」是源码，不是预构建安装包。目前公开安装包仍待首次上传。

安装前需要 **Google Chrome**，以及**已安装并登录的本机 Codex**。这些包使用 Codex 安装流程。

### 小脚本安装入口

发布后，macOS 用户也可以只下载 Releases 附件中的 `install.sh`，在文件所在目录运行：

```bash
bash ./install.sh
```

脚本自动识别 Intel / Apple Silicon，下载并校验对应安装包，再启动安装器。已有兼容 Node 时使用精简包，否则使用自带 Node 的完整包，无需 Git 或 pnpm。Windows 对应下载 Releases 的 `install.ps1`，在 PowerShell 运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`。

这里指的是 **Releases 中生成的安装引导脚本**。源码入口与安装包入口不同；上面的 Windows 源码向导已经可用，会自动准备依赖。目前 Releases 中的公开引导脚本及预构建安装包仍待首次发布。

### macOS 安装包

1. 完整解压安装包。
2. 双击 `安装网页助手-Mac.command`，按窗口提示操作。若首次被 macOS 拦截，在「系统设置 → 隐私与安全性」中确认仍要打开。
3. 在 `chrome://extensions` 开启「开发者模式」，点击「加载已解压的扩展程序」，选择安装窗口打印的目录。
4. 返回安装窗口继续，完成本机伴随程序注册；重新加载扩展。
5. 打开普通网页，点击 Tandix 图标，在输入框下方的 Agent 菜单选择 **Codex**。

### Windows 安装包

1. 完整解压安装包，不要在 ZIP 预览窗口中运行入口。
2. 双击 `安装网页助手-win.cmd`。
3. 在 `chrome://extensions` 开启「开发者模式」，加载安装窗口打印的扩展目录。
4. 返回安装窗口继续，完成本机伴随程序注册；重新加载扩展，然后在侧栏选择 **Codex**。

升级时解压新版完整包，重新双击安装入口，并在 Chrome 中重新加载扩展即可。浏览器扩展的首次加载仍需要用户操作。

## 开发者源码安装

以下步骤适合开发、修改源码或使用 dsh 的用户。

需要 Google Chrome、Git、Node.js **22.19+ 或 24+**、pnpm；macOS 还需要系统自带的 `rsync`。使用 `package.json` 指定的 pnpm 版本。

| Agent | 准备事项 |
| --- | --- |
| Codex | 本机安装可运行的 Codex CLI，并完成登录；通过 Tandix 本机伴随程序连接 |
| Cursor | 安装支持 `agent acp` 的 Cursor CLI，并运行 `agent login`；在侧栏手动选择 Cursor |
| dsh | 在 Tandix 设置中配置模型和凭据，或使用已有的 dsh 配置 |
| WorkBuddy | 安装并登录兼容 ACP 的运行时；不会自动继承 WorkBuddy 桌面账号，见[接入说明](docs/workbuddy-agent.md) |

### 本地 Cursor Agent

使用 [Cursor 官方 ACP 接口](https://cursor.com/docs/cli/acp)连接本地 CLI。先安装 Cursor CLI；已有旧版本可运行 `agent update`，再运行 `agent login` 完成登录。CLI 必须支持 `agent acp`。

在源码目录运行 `pnpm build` 和 `pnpm native:install`，然后在 Chrome 重新加载 `extensions/dsh-browser/dist` 并在侧栏 Agent 菜单选择 **Cursor**。单独刷新扩展不能更新已复制的本机伴随程序。现有 Windows 安装向导不会自动安装 Cursor CLI，需先自行安装，再更新源码伴随程序。

默认查找 `cursor-agent` 和 `agent`，包括 `~/.local/bin`。路径不在标准位置时，注册时运行 `CURSOR_AGENT_PATH=/absolute/path/to/agent pnpm native:install`（PowerShell 使用 `$env:CURSOR_AGENT_PATH`）。连接失败会显示升级或登录提示，不会回退到其他 Agent。

支持流式回复、独立历史、恢复会话、停止任务、工具授权及 Tandix 网页/Skill 工具；恢复和图片能力取决于运行时声明。会话历史保存在 `cursor-sessions.json`，与其他 Agent 分开。当前未接入 Cursor 专用问答卡和计划审批，收到这类请求会返回取消。自动化测试使用 ACP 替身，真实账号和浏览器仍需验收。

### macOS

```bash
git clone https://github.com/samchen2009/tandix.git
cd tandix
bash scripts/install/source-unix.sh
```

安装器构建浏览器桥和扩展。随后：

1. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择安装器打印的目录，默认是 `~/.dsh/browser-extension`。目录选择器中可按 `Cmd+Shift+G` 粘贴路径。
3. 回到工程目录运行 `pnpm native:install`，注册本机伴随程序；再重新加载扩展，并接受本机通信权限。
4. 打开一个普通网页，点击 Tandix 图标，在侧栏输入框下方选择 Agent。自动选择依次尝试 Codex、Cursor、WorkBuddy、dsh；手动指定 Agent 时连接失败不会切换到其他 Agent。

也可在克隆后的工程里运行 `bash ./安装网页助手.command`，按提示完成加载和注册。

### Windows

在 PowerShell 运行：

```powershell
git clone https://github.com/samchen2009/tandix.git
cd tandix
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\source-windows.ps1
```

也可以解压 GitHub 的源码 ZIP，双击根目录的 `安装网页助手.cmd`。上述两个入口都会进入同一完整向导，自动安装依赖、构建、注册插件、注册本机连接程序并检查连接。

按窗口提示完成 Chrome 扩展首次加载和 Agent 登录，然后重新加载扩展。无需另外执行 `pnpm native:install` 或保持 `pnpm start` 运行。向导默认按 Codex、Cursor、WorkBuddy、dsh 的优先级选择已就绪 Agent；dsh 的模型与凭据仍在 Tandix 设置中配置。WorkBuddy 接入兼容 ACP 的 CLI，不会复用桌面版账号，见[接入说明](docs/workbuddy-agent.md)。

若要直接验证 WorkBuddy：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\windows.ps1 -Agent workbuddy
```

自动识别扩展 ID 失败时，向导会提示从 Chrome 扩展卡片复制 ID，无需再执行其他注册命令。

### 更新

在已有 checkout 中运行 `git pull --ff-only`，重新执行对应系统的安装脚本，并在 Chrome 中重新加载扩展。macOS 如伴随程序有更新，再运行 `pnpm native:install`。运行中的任务应先停止。

## 使用

打开要操作的网页，在侧栏描述任务。需要授权时核对操作并确认。完成后检查页面中的实际结果；需要复用时点击「提炼技能」，检查流程并保存到 Skills。

Chrome 中已保存的技能统一存放在 `~/.tandix/skills`，独立于安装目录和扩展 ID；升级后会自动迁移当前扩展中仍可读取的旧技能。更换目录、重装和备份说明见[技能存储](docs/agent-skills.md#persistent-skill-library-chrome)。

Codex 和 dsh 支持目标卡；Cursor 和 WorkBuddy 的目标、视频及指定沙箱目录暂未接入。浏览器授权与本机文件权限分别管理。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

构建产物在 `extensions/dsh-browser/dist`，可直接加载为 Chrome 扩展。另见[架构说明](docs/architecture.md)、[Skill 格式](docs/agent-skills.md)及[网页调用接口](docs/web-api.md)（prompt + PDF / 多张图片 → 文本或 JSON，无需展开侧栏）。

安装依赖时会安装自动升版钩子，普通提交自动递增 `0.x.y` 中的 `y` 并同步发布信息。`x` 手动调整：在根目录 `package.json` 中修改并暂存新起点（例如 `0.3.0`）。已有 checkout 可运行 `pnpm hooks:install`，详见[开发升版说明](scripts/dev/README.md)。

## 致谢与许可

Tandix 基于 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 开发，感谢原作者 Yuxiang Lin 及贡献者提供浏览器工具和安全机制的基础。

使用 [MIT License](LICENSE)，保留原工程版权声明。
