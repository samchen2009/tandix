#!/bin/bash
# Double-click entry point for a local Tandix checkout on macOS.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$ROOT/.tandix-prebuilt" ]; then
  export TANDIX_PREBUILT=1
fi

finish() {
  printf '\n按回车键关闭此窗口。\n'
  read -r _answer
}

if [ "$(uname -s)" != "Darwin" ]; then
  printf '此双击入口用于 macOS。Windows 请运行“安装网页助手.cmd”。\n'
  finish
  exit 1
fi

printf '网页助手（Tandix）安装向导\n\n'
if ! /bin/bash "$ROOT/scripts/install.sh"; then
  printf '\n安装未完成。请查看上面的错误信息。\n'
  finish
  exit 1
fi

printf '\n请在已经打开的 Chrome 扩展页面加载“网页助手”扩展：\n'
printf '1. 打开“开发者模式”，点击“加载已解压的扩展程序”。\n'
printf '2. 选择 %s\n' "${DSH_HOME:-$HOME/.dsh}/browser-extension"
printf '3. 确认页面出现“网页助手”卡片后，回到此窗口按回车。\n'
read -r _answer

if ! (cd "$ROOT" && pnpm native:install); then
  printf '\n未检测到唯一的网页助手扩展。请在 Chrome 完成加载，或确认只加载了一个副本。\n'
  printf '完成后按回车重试；直接关闭此窗口则保留已安装的扩展文件。\n'
  read -r _answer
  if ! (cd "$ROOT" && pnpm native:install); then
    printf '\n本机伴随程序未安装成功。请查看上面的错误信息。\n'
    finish
    exit 1
  fi
fi

open -a 'Google Chrome' 'chrome://extensions' >/dev/null 2>&1 || true
printf '\n本机伴随程序已安装。请在 Chrome 的“网页助手”卡片上点击“重新加载”，\n'
printf '然后打开一个普通网页，点击扩展图标打开侧栏。\n'
finish
