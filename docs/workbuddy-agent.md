# WorkBuddy Agent 接入

Tandix 的 Agent 菜单新增 WorkBuddy。侧栏消息由本机伴随程序转发给本地 ACP Agent，网页工具仍由 Tandix 扩展执行。支持流式回复、创建和恢复会话、停止任务、工具授权及 Tandix Skill 工具。

## 接入范围

当前实现连接 **WorkBuddy/CodeBuddy 引擎的兼容 ACP 运行时**，不是 WorkBuddy 桌面应用的对话 API。发现顺序为 `WORKBUDDY_AGENT_PATH` 指定的绝对路径、`codebuddy-lite-wb`、`codebuddy`。被选中的程序必须支持 `--acp` 和 ACP v1；名称相同并不保证协议兼容，连接时会执行协议握手。

CodeBuddy CLI 的安装、登录和 ACP 用法见官方文档：[安装](https://www.codebuddy.cn/docs/cli/installation)、[登录](https://www.codebuddy.cn/docs/cli/quickstart)、[ACP](https://www.codebuddy.cn/docs/cli/acp)。**CodeBuddy CLI 登录态不能直接视作 WorkBuddy 桌面登录态。** WorkBuddy 桌面消息开放接口需要独立的开发者应用授权凭证，当前实现没有接入该接口。

## 本地测试

1. 安装兼容 CLI，例如 `npm install -g @tencent-ai/codebuddy-code`，运行 `codebuddy` 完成该 CLI 的登录，然后退出交互会话。
2. 在仓库运行 `pnpm build`，生成 `extensions/dsh-browser/dist`。
3. 更新本机伴随程序。macOS/Windows 源码安装可运行 `pnpm native:install`（Windows PowerShell 可用 `pnpm.cmd native:install`）；已使用独立安装包的环境需要重新生成并运行包含本次改动的安装包。只刷新 Chrome 扩展不足以更新已复制的伴随程序。
4. 在 Chrome 扩展管理页重新加载构建目录，在 Tandix 输入框下方的 Agent 菜单选择 WorkBuddy，发送“读取当前网页，告诉我标题”。
5. 验证流式回复、切换网页、创建新会话和停止任务。检查会话记录没有混入 Codex/dsh 的会话。

如果程序不在标准路径，可在注册伴随程序时保存路径：

```sh
WORKBUDDY_AGENT_PATH=/absolute/path/to/agent pnpm native:install
```

路径会写入本机伴随配置；不要把账号密钥放入路径或命令参数。自动选择依次尝试 Codex、Cursor、WorkBuddy、dsh。手动指定 Agent 时，连接失败不会回退到其他 Agent。

## 当前限制与验证

- 恢复历史会话要求运行时声明 `loadSession` 能力。历史消息保存在伴随程序的 `workbuddy-sessions.json`，不读取其他 Agent 的历史。
- 图片支持取决于 ACP 运行时声明的能力；视频、持久目标和会话删除尚未接入。
- 指定沙箱目录时会拒绝连接，因为当前 ACP 适配器还不能保证该目录的访问边界。
- 授权仅映射本次允许/拒绝，不授予永久权限。浏览器回调使用独立凭据及会话路由。
- `node --test scripts/tests/workbuddy.test.mjs` 使用协议测试替身，覆盖 ACP 子进程 → MCP → WebSocket 浏览器工具 → 回复链路，不能代替真实账号和真实浏览器验收。

## Windows 完整安装与修复

更新源码后，在源码根目录运行下面的向导，或双击 `安装网页助手.cmd`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\windows.ps1 -Agent workbuddy
```

向导会自动准备 Node、私有 pnpm、dsh、CodeBuddy CLI、Codex CLI，检测已有 Cursor CLI，构建扩展并注册本机伴随程序。Chrome 首次加载扩展和账号登录需要你按提示完成，Cursor CLI 需自行安装并登录。默认按 Codex、Cursor、WorkBuddy、dsh 的顺序选择首个连接检查通过的 Agent；`-Agent workbuddy` 要求 WorkBuddy 的连接检查通过。

向导会验证本机消息通道、Agent 身份、WebSocket 握手和会话列表。WorkBuddy 还会进行一次无模型提示的 ACP 会话握手，检查登录；不会在 Tandix 历史中创建测试对话。失败会显示原因，必要时打开 CLI 完成登录后重试。报告位于 `%LOCALAPPDATA%\Tandix\install-report.json`，安装日志位于同目录的 `install.log`。无需手动保持 `pnpm start` 运行。

如使用另一个已登录的 ACP 运行时，可在运行向导前设置：

```powershell
$env:WORKBUDDY_AGENT_PATH = 'C:\你的实际路径\codebuddy.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install\windows.ps1 -Agent workbuddy
```

CLI 的安装与登录依据[CodeBuddy 官方说明](https://www.codebuddy.cn/docs/cli/installation)、[登录说明](https://www.codebuddy.cn/docs/cli/quickstart)。Codex CLI 的可选安装依据 [OpenAI 官方说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。Windows CI 覆盖完整安装、实际代理程序与真实 dsh 连接；ACP 自动化链路使用测试运行时，真实第三方账号登录仍需要用户完成。
