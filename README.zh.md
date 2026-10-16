# Tandix

让 Agent 在你正在使用的网页上完成任务，并把验证过的流程整理成可复用 Skill。

[English](README.md) | 中文

## 功能

- 在 Chrome 侧栏对话，读取网页、填写表单、切换标签页并完成跨网站操作。
- 连接本地 Codex、DeepSeek Harness（dsh）或兼容 ACP 的 WorkBuddy/CodeBuddy 运行时。
- 记录网页操作，与 Agent 讨论流程，再保存、查看和运行 Tandix Skill。
- 查看工具调用、处理授权请求、停止任务和恢复历史。

长历史中的任务关联推断目前是实验性 CLI，尚未接入侧栏自动提炼，见[活动推断说明](docs/activity-inference.md)。

## 命令行安装（源码方式）

先安装 **Google Chrome** 和 **Node.js 22.19+ 或 24+（含 npm）**，重新打开终端。不需要 Git，也不需要全局安装 pnpm；下面的入口会临时使用项目固定的 pnpm 11.7.0，下载源码并构建。依赖和源码下载需要联网。

**macOS**，在终端运行：

```bash
curl -fL https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-macos.sh -o install-macos.sh && bash ./install-macos.sh
```

**Windows**，在 PowerShell 5.1 或更高版本运行：

```powershell
$installer = Join-Path $env:TEMP 'tandix-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-windows.ps1' -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

也可以直接下载 [macOS 脚本](scripts/install-macos.sh)或 [Windows 脚本](scripts/install-windows.ps1)，保存后运行。脚本不会全局修改 PowerShell 执行策略。

安装后，在 `chrome://extensions` 开启「开发者模式」，选择「加载已解压的扩展程序」，加载脚本打印的目录（默认 `~/.dsh/browser-extension`）。按脚本最后打印的启动命令运行 dsh，在 Tandix 中选择 **dsh** 并配置模型。macOS 如需 Codex，先加载扩展，再按脚本提示注册本机伴随程序。Windows 的此源码流程使用 dsh；Codex 需要下面的专用安装包。

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

这里指的是 **Releases 中生成的安装引导脚本**；仓库里的 `scripts/install.sh` 和 `scripts/install.ps1` 是下面的源码安装器，需要 Node 和 pnpm。目前上述公开脚本及安装包均待首次发布。

### macOS 安装包

1. 完整解压安装包。
2. 双击 `安装网页助手-Mac.command`，按窗口提示操作。若首次被 macOS 拦截，在「系统设置 → 隐私与安全性」中确认仍要打开。
3. 在 `chrome://extensions` 开启「开发者模式」，点击「加载已解压的扩展程序」，选择安装窗口打印的目录。
4. 返回安装窗口继续，完成本机伴随程序注册；重新加载扩展。
5. 打开普通网页，点击 Tandix 图标，在顶部 Agent 菜单选择 **Codex**。

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
| dsh | 在 Tandix 设置中配置模型和凭据，或使用已有的 dsh 配置 |
| WorkBuddy | 安装并登录兼容 ACP 的运行时；不会自动继承 WorkBuddy 桌面账号，见[接入说明](docs/workbuddy-agent.md) |

### macOS

```bash
git clone https://github.com/samchen2009/tandix.git
cd tandix
bash scripts/install.sh
```

安装器构建浏览器桥和扩展。随后：

1. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择安装器打印的目录，默认是 `~/.dsh/browser-extension`。目录选择器中可按 `Cmd+Shift+G` 粘贴路径。
3. 回到工程目录运行 `pnpm native:install`，注册本机伴随程序；再重新加载扩展，并接受本机通信权限。
4. 打开一个普通网页，点击 Tandix 图标，在侧栏顶部选择 Agent。自动选择优先尝试 Codex，再尝试 dsh；WorkBuddy 需手动选择。

也可在克隆后的工程里运行 `bash ./安装网页助手.command`，按提示完成加载和注册。

### Windows

在 PowerShell 运行：

```powershell
git clone https://github.com/samchen2009/tandix.git
cd tandix
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

1. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择脚本打印的目录，默认是 `$HOME\.dsh\browser-extension`。
3. 在工程目录运行 `pnpm start`，保持窗口运行。打开 Tandix 侧栏并选择 **dsh**，在设置中配置模型。

源码安装的 Windows 流程目前使用手动运行的 dsh。Codex/ACP 本机伴随程序需要单独准备支持 Windows 的安装包；`pnpm native:install` 的源码入口目前只支持 macOS。

### 更新

在已有 checkout 中运行 `git pull --ff-only`，重新执行对应系统的安装脚本，并在 Chrome 中重新加载扩展。macOS 如伴随程序有更新，再运行 `pnpm native:install`。运行中的任务应先停止。

## 使用

打开要操作的网页，在侧栏描述任务。需要授权时核对操作并确认。完成后检查页面中的实际结果；需要复用时点击「提炼技能」，检查流程并保存到 Skills。

Codex 和 dsh 支持目标卡；WorkBuddy 的目标、视频及指定沙箱目录暂未接入。浏览器授权与本机文件权限分别管理。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

构建产物在 `extensions/dsh-browser/dist`，可直接加载为 Chrome 扩展。另见[架构说明](docs/architecture.md)和 [Skill 格式](docs/agent-skills.md)。

## 致谢与许可

Tandix 基于 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 开发，感谢原作者 Yuxiang Lin 及贡献者提供浏览器工具和安全机制的基础。

使用 [MIT License](LICENSE)，保留原工程版权声明。
