# Tandix

Let an agent work in the browser you already use, then turn reviewed workflows into reusable skills.

English | [中文](README.zh.md)

## Features

- Chat in the Chrome side panel, read pages, fill forms, switch tabs, and work across websites.
- Connect local Codex, DeepSeek Harness (dsh), or a compatible WorkBuddy/CodeBuddy ACP runtime.
- Record browser actions, discuss the workflow, and save, inspect, or run Tandix skills.
- Inspect tool activity, answer approval requests, stop tasks, and revisit conversations.

Task inference from long, interleaved histories is currently an experimental CLI, rather than an automatic side-panel feature. See [activity inference](docs/activity-inference.md).

## Command-line installation (from source)

Install **Google Chrome** and **Node.js 22.19+ or 24+ with npm**, then reopen your terminal. No Git or global pnpm installation is needed. These entry points use the project's pinned pnpm 11.7.0 to download and build the source. Internet access is required for source and dependencies.

**macOS**, in Terminal:

```bash
curl -fL https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-macos.sh -o install-macos.sh && bash ./install-macos.sh
```

**Windows**, in PowerShell 5.1 or newer:

```powershell
$installer = Join-Path $env:TEMP 'tandix-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri 'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install-windows.ps1' -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
```

Alternatively, download the [macOS script](scripts/install-macos.sh) or [Windows script](scripts/install-windows.ps1) and run the saved file. The scripts do not change the global PowerShell execution policy.

After installation, enable **Developer mode** in `chrome://extensions`, choose **Load unpacked**, and select the printed directory (normally `~/.dsh/browser-extension`). Follow the final startup commands, select **dsh** in Tandix, and configure a model. For Codex on macOS, load the extension first, then follow the companion registration command. This Windows source flow uses dsh; Codex requires the dedicated installer package below.

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

This refers to the **generated release bootstrap scripts**. The repository's `scripts/install.sh` and `scripts/install.ps1` are source installers and require Node and pnpm. The first public script and package upload is still pending.

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
| dsh | Configure a model and credentials in Tandix Settings, or use an existing dsh configuration |
| WorkBuddy | Install and sign in to a compatible ACP runtime; desktop WorkBuddy login is not automatically reused. See [setup](docs/workbuddy-agent.md) |

### macOS

```bash
git clone https://github.com/samchen2009/tandix.git
cd tandix
bash scripts/install.sh
```

The installer builds the browser bridge and extension. Then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the printed directory, normally `~/.dsh/browser-extension`. Press `Cmd+Shift+G` in the picker to paste the path.
3. Run `pnpm native:install` from the repository directory to register the companion. Reload the extension and accept its native-messaging permission.
4. Open a regular webpage, click Tandix, and select an agent. Automatic tries Codex before dsh; select WorkBuddy explicitly.

Alternatively, run `bash ./安装网页助手.command` in the cloned checkout and follow the loading and registration prompts.

### Windows

Run in PowerShell:

```powershell
git clone https://github.com/samchen2009/tandix.git
cd tandix
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the printed extension directory, normally `$HOME\.dsh\browser-extension`.
3. Run `pnpm start` from the repository directory and keep the window open. Open Tandix, select **dsh**, and configure a model in Settings.

This Windows source-installation path uses a manually started dsh process. Codex/ACP native companions require a separately prepared Windows-compatible installer package. The source `pnpm native:install` entry currently supports macOS only.

### Updating

Run `git pull --ff-only`, rerun the installer for your operating system, and reload Tandix in Chrome. On macOS, rerun `pnpm native:install` when the companion changes. Stop active tasks first.

## Usage

Open the page you want to work with and describe the task in the side panel. Review authorization requests before approving them. Inspect the actual result on the page; to reuse the workflow, choose **Create skill**, review the instructions, and save them to Skills.

Goal cards are supported by Codex and dsh. WorkBuddy goals, video prompts, and selected sandbox directories are not yet supported. Browser approvals and local filesystem permissions are managed separately.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The extension is built into `extensions/dsh-browser/dist`; load that directory directly during development. See [architecture](docs/architecture.md) and [skill format](docs/agent-skills.md).

## Acknowledgements and license

Tandix builds on [dsh-browser](https://github.com/omdsh-dev/dsh-browser). Thanks to Yuxiang Lin and the original contributors for the browser tools and security foundations.

Released under the [MIT License](LICENSE), with the original copyright notice retained.
