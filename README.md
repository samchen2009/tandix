# Tandix

Let an agent work in the browser you already use, then turn reviewed workflows into reusable skills.

English | [中文](README.zh.md)

## Features

- Chat in the Chrome side panel, read pages, fill forms, switch tabs, and work across websites.
- Connect local Codex, DeepSeek Harness (dsh), or a compatible WorkBuddy/CodeBuddy ACP runtime.
- Record browser actions, discuss the workflow, and save, inspect, or run Tandix skills.
- Inspect tool activity, answer approval requests, stop tasks, and revisit conversations.

Task inference from long, interleaved histories is currently an experimental CLI, rather than an automatic side-panel feature. See [activity inference](docs/activity-inference.md).

## Prerequisites

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
