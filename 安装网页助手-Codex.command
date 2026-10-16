#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
finish() { printf '\n按回车键关闭此窗口。\n'; read -r _answer </dev/tty || true; }
if [ "$(uname -s)" != "Darwin" ]; then
  printf '此入口用于 macOS；Windows 请运行同目录中的“安装网页助手-win.cmd”。\n'
  finish; exit 1
fi
printf '网页助手（Tandix）Codex 版安装\n\n'
if ! NODE_BIN="$(bash "$ROOT/scripts/install/node-macos.sh")"; then finish; exit 1; fi
if ! "$NODE_BIN" "$ROOT/scripts/install/codex.mjs" prepare; then finish; exit 1; fi
open -a 'Google Chrome' 'chrome://extensions' >/dev/null 2>&1 || true
printf '\n在 Chrome 打开 chrome://extensions，开启“开发者模式”，点击“加载已解压的扩展程序”。\n'
printf '选择上方打印的 Chrome extension folder，然后回到这里按回车。\n'
if ! read -r _answer </dev/tty; then printf '需要交互式终端来完成扩展加载。\n' >&2; exit 1; fi
if ! "$NODE_BIN" "$ROOT/scripts/install/codex.mjs" register; then
  printf '\n自动识别扩展 ID 失败。请从 chrome://extensions 的“网页助手”卡片复制 ID：\n'
  if ! read -r extension_id </dev/tty; then printf '需要交互式终端输入扩展 ID。\n' >&2; exit 1; fi
  if ! "$NODE_BIN" "$ROOT/scripts/install/codex.mjs" register "$extension_id"; then finish; exit 1; fi
fi
printf '\n安装完成。请在 Chrome 扩展页面重新加载网页助手，在侧栏连接设置中选择 Codex。\n'
printf '首次使用前，请确认 Codex CLI 已登录 ChatGPT。\n'
finish
