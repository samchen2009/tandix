# Kimi Code、Qwen Code、OpenCode 与 Gemini CLI

Tandix 支持连接这四种已安装的本机 ACP CLI。在侧栏输入框下方选择对应 Agent，消息、流式回复、停止、工具授权、浏览器工具和 Tandix Skill 工具均经共享 ACP 桥接层转发。模型与账号由各 CLI 自己管理。

| Agent | 必需的 ACP 命令 | 登录或模型配置 | 非标准安装路径 |
| --- | --- | --- | --- |
| Kimi Code | `kimi acp` | 先运行 `kimi`，按 CLI 提示登录 | `KIMI_AGENT_PATH` |
| Qwen Code | `qwen --acp` | 先运行 `qwen`，完成认证和模型配置 | `QWEN_AGENT_PATH` |
| OpenCode | `opencode acp` | 先运行 `opencode auth login`，配置可用模型 | `OPENCODE_AGENT_PATH` |
| Gemini CLI | `gemini --acp` | 先运行 `gemini`，完成认证 | `GEMINI_AGENT_PATH` |

这些 CLI 需自行安装；Tandix 安装器不会为用户开通账号、购买订阅或填写密钥。是否使用包月额度取决于 CLI 的认证方式、厂商规则和套餐限制。OpenCode 是多模型运行时，不自带通用包月额度。

官方接入说明：[Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/ides)、[Qwen ACP](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)、[OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/)、[Gemini ACP](https://geminicli.com/docs/cli/acp-mode/)。请使用支持上述命令和 ACP v1 的版本。

## 安装与更新 Tandix

1. 安装并登录所选 CLI。
2. 源码安装执行 `pnpm install`、`pnpm build` 和 `pnpm native:install`。已有安装可重新运行完整 Tandix 安装入口，更新本机伴随程序与扩展。
3. 在 Chrome 扩展管理页重新加载 Tandix，选择 Agent，发送“读取当前网页并告诉我标题”。

自定义路径必须为本机可执行文件的绝对路径，在注册伴随程序时保存。例如：

```bash
KIMI_AGENT_PATH=/absolute/path/to/kimi pnpm native:install
```

Windows 可使用 `$env:KIMI_AGENT_PATH = 'C:\path\to\kimi.exe'`。完整 Windows 向导支持 `-Agent kimi|qwen|opencode|gemini`，会发现已有 CLI 并检查真实本机消息、WebSocket 和 ACP 会话；例如 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install/windows.ps1 -Agent qwen`。

自动选择依次尝试 Codex → Cursor → WorkBuddy → Kimi Code → Qwen Code → OpenCode → Gemini CLI → dsh。手动指定 Agent 时，连接失败会报错，不会切换到其他 Agent。新增后端就绪检查会创建一个无模型提示的 ACP 会话，不写入 Tandix 历史；上游 CLI 可能保留这个检查会话。

## 能力与限制

- 每个后端分别保存 Tandix 会话索引；不自动导入该 CLI 的全部历史。旧会话恢复需要 CLI 宣告并实现 `loadSession`。
- 模型列表、推理选项和图片输入以 CLI 宣告的能力为准。支持现代 `configOptions`，以及 Gemini 等版本使用的旧式 `models` 选择接口。
- 本机文件下载沿用 ACP 的会话文件校验。OpenCode 的每个 Tandix 会话使用独立任务目录，防止其目录级 MCP 配置覆盖其他会话；目录不是操作系统沙箱。
- 目标卡、视频输入、指定沙箱目录暂未接入这些 ACP 后端；指定沙箱目录时会明确拒绝启动。客户端文件系统和终端反向 RPC 未开放。浏览器授权继续由 Tandix 扩展检查。
- 当前自动化测试使用 ACP 测试运行时，验证真实子进程、MCP、WebSocket、权限、取消和恢复协议；不等于已完成四家真实账号和实际网页的端到端验收。
