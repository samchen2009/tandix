# Tandix

Let an agent work in the browser you already use, then turn reviewed workflows into reusable skills.

English | [中文](README.zh.md)

## Features

- Chat in the Chrome side panel, read pages, fill forms, switch tabs, and work across websites.
- Connect local Codex, Cursor CLI, DeepSeek Harness (dsh), or a compatible WorkBuddy/CodeBuddy ACP runtime.
- Record browser actions, discuss the workflow, and save, inspect, or run Tandix skills.
- Inspect tool activity, answer approval requests, stop tasks, and revisit conversations.

Task inference from long, interleaved histories is currently an experimental CLI, rather than an automatic side-panel feature. See [activity inference](docs/activity-inference.md).

## Command-line installation (from source)

Scripts are grouped by purpose; see [scripts/README.md](scripts/README.md) for installers, runtime components, and release tools. For everyday installation, use the double-click launcher in the repository root.

**Windows, without commands:** download [安装网页助手.cmd](https://raw.githubusercontent.com/samchen2009/tandix/main/%E5%AE%89%E8%A3%85%E7%BD%91%E9%A1%B5%E5%8A%A9%E6%89%8B.cmd), save it, and double-click. If your browser displays the script, right-click the link and choose **Save link as**, keeping the `.cmd` extension. This single file downloads the latest wizard, detects architecture and existing tools, installs missing dependencies, builds the extension, registers its companion, and checks connections. No source ZIP, Node, pnpm, or Git is needed beforehand. Inside a source checkout, the same launcher uses that checkout's local code.

On macOS, install **Google Chrome** and **Node.js 22.19+ or 24+ with npm**. The Windows wizard automatically prepares Node.js, private pnpm 11.7.0, Chrome, dsh, WorkBuddy/CodeBuddy CLI and Codex CLI. No Git is required. Downloads require internet access. Compatible existing runtimes and sign-in settings are preserved.

**macOS**, in Terminal:

```bash
curl -fL https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/macos.sh -o install-macos.sh && bash ./install-macos.sh
```

**Windows**, in PowerShell 5.1 or newer:

```powershell
$installer = Join-Path $env:TEMP 'tandix-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/windows.ps1' -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

Alternatively, download the [macOS script](scripts/install/macos.sh) or [Windows script](scripts/install/windows.ps1) and run the saved file. The scripts do not change the global PowerShell execution policy.

On the first install, enable **Developer mode** in `chrome://extensions`, choose **Load unpacked**, and select the printed folder (normally `~/.dsh/browser-extension`). Windows waits for extension loading, registers the native companion and checks native messaging, WebSocket authentication and session listing. WorkBuddy also gets an ACP session authentication check. If sign-in is needed, the wizard opens the CLI for you to complete it. It never supplies your account passwords or model credentials.

Windows installs and checks all three agents by default, selecting **dsh**. Reload the extension and configure a provider/model in Tandix Settings if needed. **No `pnpm start` terminal is required**. Add `-Agent workbuddy` to use WorkBuddy as the required agent, or `-Agents dsh` to install only dsh. On macOS, continue following the printed startup or companion registration commands.

Windows logs and per-agent results are saved to `%LOCALAPPDATA%\Tandix\install.log` and `%LOCALAPPDATA%\Tandix\install-report.json`. A failed selected agent returns a failed installation status. Other agent failures are explicitly reported. If Chrome cannot be installed through the package manager, the wizard opens its official download page and waits for installation.

Rerun the entry point to update a managed source installation, then reload the extension in Chrome. The installer stops if an existing installation directory is not managed by it, to avoid overwriting it.

## Install for everyday use (recommended)

You do **not** need to clone the repository. Complete installer packages include the built Chrome extension, Node, and connection dependencies. No Git, pnpm, or source compilation is required.

Download a complete package for **Mac Apple Silicon**, **Mac Intel**, **Windows x64**, or **Windows ARM64** from [GitHub Releases](https://github.com/samchen2009/tandix/releases). Use an actual release attachment; the repository's **Download ZIP** is source code, not an installer. The first public installer upload is still pending.

You need **Google Chrome** and a **locally runnable Codex that is already signed in**. These packages use the Codex installation flow.

### Small installer script

Once published, macOS users can also download `install.sh` from the release attachments and run it from the download directory:

```bash
bash ./install.sh
```

The script detects Intel or Apple Silicon, downloads and verifies the matching package, and starts its installer. It selects the lite package when compatible Node is already available, otherwise the complete package with bundled Node. Git and pnpm are unnecessary. On Windows, download the release's `install.ps1` and run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` in PowerShell.

This refers to the **generated release bootstrap scripts**. The Windows source wizard above is already available and prepares its dependencies automatically. The first public release bootstrap and prebuilt package upload is still pending.

### macOS package

1. Fully extract the ZIP.
2. Double-click `安装网页助手-Mac.command` and follow the prompts. If macOS blocks the first launch, confirm it in **System Settings → Privacy & Security**.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the directory printed by the installer.
4. Return to the installer to register the native companion, then reload the extension.
5. Open a regular webpage, click Tandix, and select **Codex** in the agent menu.

### Windows package

1. Fully extract the ZIP; do not run the entry point inside the archive viewer.
2. Double-click `安装网页助手-win.cmd`.
3. Enable **Developer mode** in `chrome://extensions` and load the printed extension directory.
4. Return to the installer to register the companion, reload the extension, and select **Codex** in the side panel.

To update, extract the new complete package, rerun the entry point, and reload the extension. The first Chrome extension load still requires user interaction.

## Install from source (developers)

Use this path for development, source changes, or dsh.

Google Chrome, Git, Node.js **22.19+ or 24+**, and pnpm are required. macOS also needs `rsync`. Use the pnpm version specified in `package.json`.

| Agent | Setup |
| --- | --- |
| Codex | Install and sign in to a runnable local Codex CLI; connect through the Tandix native companion |
| Cursor | Install Cursor CLI with `agent acp` support and run `agent login`; select Cursor explicitly in the sidebar |
| dsh | Configure a model and credentials in Tandix Settings, or use an existing dsh configuration |
| WorkBuddy | Install and sign in to a compatible ACP runtime; desktop WorkBuddy login is not automatically reused. See [setup](docs/workbuddy-agent.md) |

### Local Cursor Agent

Connect through [Cursor's official ACP interface](https://cursor.com/docs/cli/acp). Install Cursor CLI, or run `agent update` to upgrade an older installation, then run `agent login`. The CLI must support `agent acp`.

Run `pnpm build` and `pnpm native:install` in the source checkout, reload `extensions/dsh-browser/dist` in Chrome, and select **Cursor** in the sidebar Agent menu. Reloading the extension alone does not update the copied native companion. The Windows installation wizard does not install Cursor CLI automatically; install it separately before registering the updated source companion.

Discovery checks `cursor-agent` and `agent`, including `~/.local/bin`. For a custom location, register with `CURSOR_AGENT_PATH=/absolute/path/to/agent pnpm native:install` (use `$env:CURSOR_AGENT_PATH` in PowerShell). Connection errors include upgrade/login guidance and never fall back to another agent.

Streaming replies, isolated history, session resume, cancellation, tool approvals and Tandix browser/Skill tools are supported; resume and images depend on runtime capabilities. History is stored separately in `cursor-sessions.json`. Cursor-specific question and plan-approval cards are not integrated yet; these requests receive a cancelled response. Automated tests use an ACP fixture; real-account and browser acceptance is still required.

### macOS

```bash
git clone https://github.com/samchen2009/tandix.git
cd tandix
bash scripts/install/source-unix.sh
```

The installer builds the browser bridge and extension. Then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the printed directory, normally `~/.dsh/browser-extension`. Press `Cmd+Shift+G` in the picker to paste the path.
3. Run `pnpm native:install` from the repository directory to register the companion. Reload the extension and accept its native-messaging permission.
4. Open a regular webpage, click Tandix, and select an agent. Automatic tries Codex before dsh; select Cursor or WorkBuddy explicitly.

Alternatively, run `bash ./安装网页助手.command` in the cloned checkout and follow the loading and registration prompts.

### Windows

Run in PowerShell:

```powershell
git clone https://github.com/samchen2009/tandix.git
cd tandix
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\source-windows.ps1
```

Alternatively, extract GitHub's source ZIP and double-click `安装网页助手.cmd`. Both entry points use the complete setup wizard: dependencies, source build, plugin registration, native companion registration and actual connection checks.

Follow the first-time Chrome extension-loading and sign-in prompts, then reload the extension. No separate `pnpm native:install` command or persistent `pnpm start` terminal is required. Configure your own model credentials in Tandix Settings for dsh. WorkBuddy uses a compatible ACP CLI, with separate sign-in from the desktop app; see [setup](docs/workbuddy-agent.md).

To require a working WorkBuddy connection:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\windows.ps1 -Agent workbuddy
```

If extension ID detection fails, the wizard prompts for the ID from Chrome's extension card.

### Updating

Run `git pull --ff-only`, rerun the installer for your operating system, and reload Tandix in Chrome. On macOS, rerun `pnpm native:install` when the companion changes. Stop active tasks first.

## Usage

Open the page you want to work with and describe the task in the side panel. Review authorization requests before approving them. Inspect the actual result on the page; to reuse the workflow, choose **Create skill**, review the instructions, and save them to Skills.

Goal cards are supported by Codex and dsh. Cursor and WorkBuddy goals, video prompts, and selected sandbox directories are not yet supported. Browser approvals and local filesystem permissions are managed separately.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The extension is built into `extensions/dsh-browser/dist`; load that directory directly during development. Chrome saves skills in `~/.tandix/skills`, independently of the installation path and extension ID, and automatically migrates accessible legacy skills. See [architecture](docs/architecture.md), [skill storage and format](docs/agent-skills.md), and the [webpage API](docs/web-api.md) (prompt + PDF/images → text or JSON, without an open side panel).

Installing dependencies also installs the commit-version hooks. Normal commits increment `y` in `0.x.y` and synchronize release metadata. To change `x`, stage the new starting version (for example `0.3.0`) in the root `package.json`. Existing checkouts can run `pnpm hooks:install`; see [versioning details](scripts/dev/README.md).

## Acknowledgements and license

Tandix builds on [dsh-browser](https://github.com/omdsh-dev/dsh-browser). Thanks to Yuxiang Lin and the original contributors for the browser tools and security foundations.

Released under the [MIT License](LICENSE), with the original copyright notice retained.
