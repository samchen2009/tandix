# WorkBuddy Agent 接入

Tandix 的 Agent 菜单新增 WorkBuddy。侧栏消息由本机伴随程序转发给本地 ACP Agent，网页工具仍由 Tandix 扩展执行。支持流式回复、创建和恢复会话、停止任务、工具授权及 Tandix Skill 工具。

## 接入范围

当前实现连接 **WorkBuddy/CodeBuddy 引擎的兼容 ACP 运行时**，不是 WorkBuddy 桌面应用的对话 API。发现顺序为 `WORKBUDDY_AGENT_PATH` 指定的绝对路径、`codebuddy-lite-wb`、`codebuddy`。被选中的程序必须支持 `--acp` 和 ACP v1；名称相同并不保证协议兼容，连接时会执行协议握手。

CodeBuddy CLI 的安装、登录和 ACP 用法见官方文档：[安装](https://www.codebuddy.cn/docs/cli/installation)、[登录](https://www.codebuddy.cn/docs/cli/quickstart)、[ACP](https://www.codebuddy.cn/docs/cli/acp)。**CodeBuddy CLI 登录态不能直接视作 WorkBuddy 桌面登录态。** WorkBuddy 桌面消息开放接口需要独立的开发者应用授权凭证，当前实现没有接入该接口。

## 本地测试

1. 安装兼容 CLI，例如 `npm install -g @tencent-ai/codebuddy-code`，运行 `codebuddy` 完成该 CLI 的登录，然后退出交互会话。
2. 在仓库运行 `pnpm build`，生成 `extensions/dsh-browser/dist`。
3. 更新本机伴随程序。macOS/Windows 源码安装可运行 `pnpm native:install`（Windows PowerShell 可用 `pnpm.cmd native:install`）；已使用独立安装包的环境需要重新生成并运行包含本次改动的安装包。只刷新 Chrome 扩展不足以更新已复制的伴随程序。
4. 在 Chrome 扩展管理页重新加载构建目录，在 Tandix 顶部的 Agent 菜单选择 WorkBuddy，发送“读取当前网页，告诉我标题”。
5. 验证流式回复、切换网页、创建新会话和停止任务。检查会话记录没有混入 Codex/dsh 的会话。

如果程序不在标准路径，可在注册伴随程序时保存路径：

```sh
WORKBUDDY_AGENT_PATH=/absolute/path/to/agent pnpm native:install
```

路径会写入本机伴随配置；不要把账号密钥放入路径或命令参数。自动选择仍沿用原有 Codex/dsh 策略，WorkBuddy 需要显式选择。连接失败不会回退到其他 Agent。

## 当前限制与验证

- 恢复历史会话要求运行时声明 `loadSession` 能力。历史消息保存在伴随程序的 `workbuddy-sessions.json`，不读取其他 Agent 的历史。
- 图片支持取决于 ACP 运行时声明的能力；视频、持久目标和会话删除尚未接入。
- 指定沙箱目录时会拒绝连接，因为当前 ACP 适配器还不能保证该目录的访问边界。
- 授权仅映射本次允许/拒绝，不授予永久权限。浏览器回调使用独立凭据及会话路由。
- `node --test scripts/tests/traceforge-workbuddy.test.mjs` 使用协议测试替身，覆盖 ACP 子进程 → MCP → WebSocket 浏览器工具 → 回复链路，不能代替真实账号和真实浏览器验收。

## Windows：点击连接没有反应

只构建或加载 `dist`，或只运行 `pnpm start`，都不会注册 WorkBuddy 使用的 Chrome 本机伴随程序。请更新源码后，在源码根目录执行：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd build
npm.cmd install -g @tencent-ai/codebuddy-code
codebuddy.cmd
```

按 CLI 提示完成登录后退出，确认 Chrome 已加载 Tandix 扩展，再执行：

```powershell
pnpm.cmd native:install
```

重新加载 Chrome 扩展，选择 WorkBuddy。如果自动识别扩展 ID 失败，可执行 `node scripts/traceforge-native-host.mjs install --extension-id 你的扩展ID`。注册在当前用户下完成，无需管理员权限。连接失败会在侧栏显示原因。

如果使用的是独立 `codebuddy.exe` 或其他 ACP 运行时，请先完成它的登录，并显式保存其绝对路径：

```powershell
$env:WORKBUDDY_AGENT_PATH = 'C:\你的实际路径\codebuddy.exe'
pnpm.cmd native:install
```

当前 Windows 注册流程的自动化测试使用编译器与注册表替身；真实 Windows 环境、真实 CLI 登录和 ACP 握手仍需现场验证。
