# 运行时组件

这些模块由安装器和 Chrome 本机伴随程序调用，无需逐个执行。

| 文件 | 职责 |
| --- | --- |
| `native-host.mjs` | 注册 Chrome Native Messaging 宿主，按需启动所选 Agent |
| `native-proxy.cs` | Windows 本机消息代理源码 |
| `connection-check.mjs` | 检查本机消息、WebSocket、会话列表及 WorkBuddy/Cursor 认证 |
| `codex-bridge.mjs`、`workbuddy-bridge.mjs`、`cursor-bridge.mjs`、`acp-bridge.mjs` | 对接对应 Agent |
| `codex-mcp.mjs` | Agent 调用浏览器的 MCP 服务 |
| `runtime-discovery.mjs` | 查找本机 Agent、生成启动包装器并管理子进程 |
| `portable-node.mjs` | 校验和复用安装包中的 Node |
| `browser-guidance.mjs`、`session-title.mjs`、`lark-auth.mjs` | 浏览器指引、会话标题和飞书认证辅助模块 |

源码环境注册伴随程序仍使用 `pnpm native:install`。已安装的宿主标识和配置目录保留原值，以便升级后继续识别已有注册。
