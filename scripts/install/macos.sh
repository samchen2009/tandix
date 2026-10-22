#!/bin/bash
# Standalone, clone-free source installer for macOS. No global pnpm install.
set -euo pipefail

if [ "${1:-}" = --help ]; then
  printf 'Usage: bash install-macos.sh\nRequires Chrome and Node.js 22.19+ or 24+ (with npm).\nDownloads and builds Tandix, then installs or updates its native companion.\nFirst-time Chrome extension loading requires your interaction.\n'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf 'Usage: bash install-macos.sh [--help]\n' >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ]; then
  printf 'This installer is for macOS. On Windows use install-windows.ps1.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 ||
    ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major===22&&minor>=19)||major>=24?0:1)' >/dev/null 2>&1; then
  printf 'Install Node.js 22.19+ or 24+ with npm, reopen Terminal, then retry: https://nodejs.org/en/download\n' >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/tandix-source.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
installer="$work/install.sh"
printf 'Downloading the Tandix source installer from GitHub...\n'
curl -fL --retry 2 --connect-timeout 15 \
  'https://raw.githubusercontent.com/samchen2009/tandix/main/scripts/install/source-unix.sh' -o "$installer"
# npm provides the pinned pnpm only to the child process, without changing global tools.
TANDIX_MACOS_WIZARD=1 npm exec --yes --package=pnpm@11.7.0 -- /bin/bash "$installer"

root="${DSH_HOME:-$HOME/.dsh}/dsh-browser"
host="$root/scripts/runtime/native-host.mjs"
if [ ! -f "$host" ]; then
  printf '未找到本机伴随程序，安装未完成，请重新运行安装命令。\nNative companion source is missing; rerun the installer.\n' >&2
  exit 1
fi

printf '\n正在检测 Chrome 中已加载的 Tandix 扩展……\nDetecting the loaded Tandix Chrome extension…\n'
while ! extension_id="$(node "$host" extension-id 2>"$work/extension-id.log")"; do
  printf '\n请在 chrome://extensions 开启开发者模式，加载以下目录：\nIn chrome://extensions, enable Developer mode and load:\n  %s\n' \
    "${DSH_HOME:-$HOME/.dsh}/browser-extension"
  printf '如果加载了多个 Tandix 副本，请填写本次要连接的扩展 ID。\nIf multiple Tandix copies are loaded, enter the ID of the intended copy.\n'
  printf '完成后按回车重试，或粘贴扩展卡片上的 32 位 ID：\nPress Enter to retry, or paste the extension card’s 32-letter ID: '
  if ! read -r extension_id; then
    printf '\n尚未确认 Chrome 扩展，本机伴随程序未注册。请完成加载后重新运行本安装命令。\nChrome extension not confirmed; the companion is not registered. Load the extension and rerun this command.\n' >&2
    exit 1
  fi
  if [[ "$extension_id" =~ ^[a-p]{32}$ ]]; then break; fi
  if [ -n "$extension_id" ]; then
    printf '扩展 ID 无效，应为 a–p 组成的 32 位 ID。\nInvalid extension ID; expected 32 letters from a to p.\n' >&2
  fi
done

printf '\n正在安装或更新本机伴随程序……\nInstalling or updating the native companion…\n'
(cd "$root" && npm exec --yes --package=pnpm@11.7.0 -- pnpm native:install --extension-id "$extension_id")
printf '\n扩展文件与本机伴随程序均已更新。\nExtension files and native companion are updated.\n'
printf '请在 chrome://extensions 点击 Tandix 卡片上的“重新加载”，然后重新打开侧栏。\nClick Reload on the Tandix card in chrome://extensions, then reopen its side panel.\n'
printf '无需另外执行 native:install，也无需保持 pnpm start 运行。\nNo separate native:install command or persistent pnpm start terminal is needed.\n'
