# Tandix 网页调用接口 v1

网页可以向已安装的 Tandix 提交 **prompt、PDF 或多张图片**，接收执行事件和最终文本 / JSON。网页任务不要求展开 Tandix 侧栏。接口已在源码中实现，需重新构建并重新加载扩展以及更新本机伴随程序后使用。

## 运行要求

- Chrome 116+ 或兼容的 Edge；此接口暂不支持 Firefox。
- 网页运行在 HTTPS，或开发地址 `http://localhost:<port>` / `http://127.0.0.1:<port>`。不支持 `file://` 和普通 HTTP 站点。
- 安装并启用 Tandix，完成本机伴随程序安装。在 Tandix 设置中选择 **Codex** 并完成登录。v1 文件任务只支持 Codex；dsh / WorkBuddy 返回 `unsupported-backend`，不会静默切换账号或后端。
- 已接收的任务独立于网页连接：刷新、关闭网页或 SDK 断连只会停止该网页的观察，任务继续由本机伴随程序执行。浏览器退出、扩展重载或伴随程序重启可能中断 Agent 回合；持久化的任务、原会话映射和附件仍可取回。完全断网时，依赖云端模型的计算不保证继续。
- 首次调用由用户在扩展自有授权页批准完整站点来源。授权包含协议、域名、端口；不同端口及子域需分别授权。iframe 和其他扩展不能调用本接口。

## 构建与接入

在仓库根目录运行 `pnpm build`。重新加载 `extensions/dsh-browser/dist`，并更新已安装伴随程序使用的 `scripts/runtime/codex-bridge.mjs`（可重新运行安装流程）。SDK 产物为 `extensions/dsh-browser/dist/web-api/tandix.js`，将此 ES module 复制到你的网站并从网站自己的地址导入；网页不需要访问扩展内部文件。

推荐使用 `TandixClient.discover()` 自动连接，无需用户查找或填写扩展 ID，也无需接入方枚举浏览器扩展。仍保留 `new TandixClient(extensionId)`，供需要配置固定 ID 的集成使用。仓库演示页面为 `examples/web-api/index.html`，已移除 ID 输入框。

本功能适用于新版接收并持久化的任务；升级前的临时任务没有这份映射，不能仅凭旧 taskId 自动迁移。

本地验收可在仓库根目录运行 `python3 -m http.server 8765 --bind 127.0.0.1`，然后打开 `http://127.0.0.1:8765/examples/web-api/`。新版扩展会检查伴随程序的 `webTaskApiVersion: 2`，旧版伴随程序必须更新；否则返回 `unsupported-companion`，不会创建共享工作目录中的旧式会话。

```js
import { TandixClient } from '/vendor/tandix.js';

// 可以在页面加载时静默连接，不弹授权页，也不启动 Agent。
const tandix = await TandixClient.discover();
const hello = await tandix.hello();
console.log(hello.version, hello.authorized, hello.limits);

// 以下首次授权与提交逻辑绑定到“开始处理”按钮的点击事件。
// 打开 Tandix 自有授权页，等待用户允许或拒绝，最多等待 120 秒。
if (!hello.authorized && !await tandix.authorize()) {
  throw new Error('用户拒绝或授权请求已过期');
}

// input: <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" multiple>
const task = await tandix.run({
  prompt: '读取所有附件，提取单据日期、金额和币种。无法识别的字段用 null。返回 JSON 数组。',
  files: [...document.querySelector('input[type=file]').files],
  responseFormat: 'json',
  timeoutMs: 5 * 60_000,
});

const off = task.onProgress(event => {
  if (event.type === 'delta') console.log(event.text);
  if (event.type === 'waiting-for-user') console.log('请在 Tandix 中处理本机操作授权');
});

try {
  const result = await task.result();
  console.log(result.taskId, result.text, result.data);
} finally {
  off();
  tandix.close();
}
```

`authorize()` 应由明确的用户操作触发。站点已获准后可自动调用 `run()`，不需要每次展开侧栏或再次授权。用户可通过扩展卡片的“扩展程序选项”管理及撤销授权，撤销会断开该站点现有连接并尝试取消其任务。

### 自动连接的用户体验

示例页打开后静默发现并连接 Tandix。用户只需选择文件、填写要求、点击“开始处理”；未授权站点此时才显示扩展自有的首次授权页，允许后继续上传，不需要再次点击处理。已授权站点直接执行，侧栏无需展开。自动发现不会改变站点授权，也不会启动 Agent 或发送文件。检测失败时才显示安装 / 启用及重试提示，不让用户手填 ID。

默认发现超时为 5 秒，可通过 `discover({ timeoutMs: 10000 })` 调整（允许 100–30000 ms）。发现期间每 250 ms 重试，兼容网页代码早于内容脚本加载的情况；发现请求只在当前顶层页面内传递。扩展刚安装或重新加载后，若页面仍未检测到，刷新网页重试。示例以 `file://` 打开时会直接提示使用网站或本地预览，不会卡在连接中；生产网页通过 HTTPS 接入即可。

## JavaScript SDK

| 接口 | 行为 |
| --- | --- |
| `TandixClient.discover(options?): Promise<TandixClient>` | 自动发现当前页面中的 Tandix，验证扩展通道的产品、协议版本和页面来源，返回可用客户端；不请求授权 |
| `new TandixClient(extensionId)` | 建立当前网页到扩展的连接；扩展不可用时连接失败 |
| `hello(): Promise<WebHello>` | 查询版本、授权、上限及 `taskRecovery: 1`；不启动模型任务 |
| `authorize(): Promise<boolean>` | 打开扩展授权页；已授权直接返回 `true`；拒绝或 120 秒未处理返回 `false` |
| `run(options): Promise<TandixTask>` | 分块上传附件并提交任务；返回表示已接收，不表示处理成功 |
| `task.id` | 持久化任务 ID，跨连接保持不变；建议接入方在提交前生成并保存 |
| `getTask(taskId, afterSeq?): Promise<WebTaskSnapshot>` | 查询原任务状态、原 Agent/会话映射、事件增量和已有结果；不会发送 prompt |
| `attach(taskId, { afterSeq? }?): Promise<TandixTask>` | 重新观察同一来源的原任务，回放进度并等待结果；不会重新上传、创建会话或执行模型 |
| `task.snapshot` / `task.cursor` | 最近任务快照 / 已消费事件序号，可保存以便刷新后增量恢复 |
| `task.resume({ requestId?, prompt? }?): Promise<void>` | 原任务明确处于 `interrupted` 时，在原会话内继续；先核对历史，已有结果直接返回。`requestId` 是本次继续操作的幂等 ID |
| `task.onProgress(callback)` | 回放本观察句柄缓存的最近事件并订阅后续进度，返回取消订阅函数；持久化事件用 `seq` 去重 |
| `task.result(): Promise<WebTaskResult>` | 等待最终结果；失败、取消 reject。传输断连自动恢复观察；执行超时或其他 `interrupted` 保持等待，需显式继续或取消。已完成结果可补取 |
| `task.cancel(): Promise<void>` | 持久取消同一来源的原任务；重复取消返回已有终态 |
| `close(): void` | 关闭本观察句柄及心跳；本地等待 reject，但已接收任务继续执行，可用新客户端 attach |

`RunOptions`：

```ts
interface RunOptions {
  taskId?: string;                    // 推荐提交前生成 UUID 并在业务中保存
  prompt: string;
  files?: readonly File[];            // 可省略，纯 prompt 也可调用
  responseFormat?: 'text' | 'json';   // 默认 text
  timeoutMs?: number;                 // 1000–600000，默认 600000
}
interface WebTaskResult {
  taskId: string;
  text: string;                       // Agent 最后一条完整回答
  data?: unknown;                     // JSON 模式的 JSON.parse(text) 结果
}
```

JSON 模式要求模型返回纯 JSON；扩展会实际解析，解析失败报 `invalid-json`，没有伪造或自动修补结果。v1 不提供 JSON Schema 约束，业务方仍需校验字段。最终结果是 Agent 的回答，任务完成表示 Agent 回合正常结束，业务数据是否正确仍需按业务规则检验。

持久事件 `type`：`accepted`、`creating`、`mapped`、`starting`、`started`、`resuming`、`delta`、`waiting-for-user`、`interrupted`、`completed`、`failed`、`cancelled`，每个事件带 `taskId` 和单调递增的 `seq`。SDK 另外产生不带持久序号的 `disconnected`、`snapshot` 通知；`delta` 带 `text`；`completed` 带 `result`；失败 / 取消带 `error: { code, message }`。进度文字可能包含中间说明，应以 `task.result()` 为最终结果。网页只收到自己任务的事件，不会收到全局会话、工具参数、批准凭证或其他网页的输出。需要确认的本机操作仍交由 Tandix 侧栏处理，网页不能替用户批准。

Agent 追问时任务进入 `interrupted`，保留同一任务和会话。网页可以展示经过限制的非密码问题文字，让用户补充信息，再调用 `task.resume({ requestId, prompt })`；网页不能替用户批准本机工具操作。

## 同一任务的递进恢复

任务的稳定关系为 `taskId → backend + agentId → sessionId → attempt / turnId`。Codex 的 `agentId` 是原 Codex Home 配置目录的摘要；安装目录变化不改变它，切换配置身份会返回 `agent-mismatch`，防止接到其他 Agent 上。每次继续只增加 `attempt`，保持 `taskId`、Agent 身份、会话 ID 和工作目录不变。所有读取都检查 Chrome 提供的真实 origin；知道 taskId 不会获得其他站点的任务。

建议业务先生成并保存 taskId，再调用 `run`。同一 taskId、相同 prompt / 附件 / 返回格式 / 超时的重复提交返回原任务；输入不同则报 `task-conflict`。同一继续操作的 requestId + prompt 也只接受一次。**重连、attach、get 和 SDK 自动恢复均不会调用模型**。任务创建、映射或 prompt 派发结果不确定时保持中断，避免靠重试制造重复批改。

```js
// 首次提交：先保存 ID，避免“任务已接收，但网页没收到回执”后丢失关联。
const taskId = crypto.randomUUID();
localStorage.setItem('gradingTaskId', taskId);
const task = await tandix.run({ taskId, prompt, files, responseFormat: 'json' });
task.onProgress(event => {
  if (event.seq) localStorage.setItem(`cursor:${taskId}`, String(event.seq));
});
const result = await task.result();

// 页面刷新后：使用原 ID，既不重传附件，也不重新提交批改。
const recovered = await tandix.attach(localStorage.getItem('gradingTaskId'), {
  afterSeq: Number(localStorage.getItem(`cursor:${taskId}`) || 0),
});
console.log(recovered.snapshot); // 查看原 sessionId、状态和 attempt
const originalResult = await recovered.result();
```

`WebTaskSnapshot` 字段：`taskId`、`backend`、`agentId`、`sessionId`（映射前为 null）、`turnId`、`status`、`attempt`、`createdAt`、`updatedAt`、`lastSeq`、`cursor`、`hasMore`、`reset`、`text`、`events`、`resumable`、可选的 `result` / `error`。状态依次为 `accepted → creating → ready → dispatching → running`，再到 `completed` / `failed` / `cancelled`；中断进入 `interrupted`，继续后进入下一次 dispatching / running。事件序号跨 attempt 递增，不重置。保留最近 500 个进度事件；老游标被截断时 `reset: true`，用 `text` 快照恢复展示，再处理增量。流式 delta 最多延迟 250ms 合并落盘，硬崩溃可能丢失这段尚未刷盘的显示文字；最终结果完整落盘后才报告完成。

当进度事件为 `interrupted`、快照 `resumable: true` 时，向用户显示原因，提供“继续原任务”。这属于显式继续原任务，不能自动替用户重新批改：

```js
// 在“继续原任务”的点击事件中调用；接入方保存本次 requestId，回执丢失时复用。
const requestId = crypto.randomUUID();
localStorage.setItem(`resume:${task.id}`, requestId);
await task.resume({ requestId, prompt: '保留已完成批改，只继续剩余题目。' });
```

继续前先检查原会话历史：已经完成则直接补取结果；回合仍运行时返回 `task-busy`，继续观察；确已中断才以原 sessionId 恢复上下文、禁用网页任务的浏览器 MCP，并在原工作目录发送继续指令。Codex 适配使用分页 `thread/turns/list` 读取最后一个回合，并以 `thread/resume` + `excludeTurns: true` 恢复原线程；旧版历史接口保留兼容回退，依据[官方 App Server 协议](https://learn.chatgpt.com/docs/app-server)。无法确认状态时返回错误，不创建新会话或自动重发原 prompt。会话创建回执丢失且还没记录 sessionId 时，也不会猜测或另建会话。

本功能保证可确认状态下的任务关联、事件 / 结果补取与原会话继续，不能保证云端模型在任何网络故障后从同一个 token 的内部计算位置继续。模型已经执行、但未持久记录或无法验证的动作，也无法获得通用的“恰好一次”保证。业务应根据已完成步骤和输出继续工作；进程退出、账号登出或上游历史被删除时可能需要人工介入。

## 上传限制

| 项目 | v1 上限 |
| --- | --- |
| 附件数 | 每任务最多 10 个，可混合 PDF 与图片 |
| PDF | 单文件最多 25 MiB |
| 图片 | 单文件最多 10 MiB；PNG / JPEG / WebP / GIF |
| 全部附件合计 | 每连接最多 25 MiB，按原始字节计 |
| 图片尺寸 | 每边最多 8192 px，最多 3600 万像素；后台实际解码检查 |
| prompt | 最多 64000 个 JavaScript UTF-16 字符单元 |
| 最终文字 | 最多 1000000 个 JavaScript UTF-16 字符单元 |
| 分块大小 | 每块最多 192 KiB 原始字节，对应最多 256 KiB base64 |
| 并行度 | 每连接 1 个上传 / 任务流程，扩展最多 4 个活跃网页任务、8 个网页连接 |
| 超时 | 每个执行尝试最多 10 分钟，包含 Agent 启动和等待确认；显式继续产生新的 attempt，使用相同超时上限 |

SDK 接受浏览器 `File`，不接受远端 URL、本机路径、Cookie、Agent 密钥或 data URL。文件名不能包含目录分隔符及控制字符。扩展检查 MIME、文件头、长度、上传顺序和图片解码，拒绝缺块及超限数据。PDF 使用 Agent 本机文件读取 / 解析工具处理，不是模型原生 PDF API；扫描件 OCR、加密 PDF、复杂排版的识别能力取决于 Agent / 模型及已安装工具，不保证环境具备 OCR。

## 底层消息协议

自动发现是建立连接前的独立步骤：SDK 对当前窗口执行 `window.postMessage({ type: 'tandix:discover:v1', requestId }, location.origin)`，其中 `requestId` 为本次随机 UUID。Tandix 的顶层内容脚本仅回应同窗口、同来源且格式有效的请求，返回 `{ type: 'tandix:discovered:v1', requestId, product: 'tandix', version: 1, extensionId, extensionVersion }`。SDK 校验关联 ID，随后使用真实扩展 Port 的 `hello` 再次核对 `product`、`version` 和 `origin`，超时关闭临时连接。

该广播仅提供公开的发现信息，不是身份认证或任务通道；不通过 `postMessage` 传附件、prompt 或授予权限。实际调用仍须经过扩展自有授权页及后台的来源检查。不会查询其他扩展或索取 `management` 权限。

Chrome `runtime.connect(extensionId, { name: 'tandix-web-v1' })` 建立长连接，扩展通过 `runtime.onConnectExternal` 接收。传输为 JSON；prompt 是消息字段，文件内容采用 base64。网页必须使用清单允许的来源，并通过扩展内的逐站授权。

请求：

```json
{ "id": "request-uuid", "method": "files.begin", "params": { "name": "report.pdf", "mediaType": "application/pdf", "bytes": 1024 } }
```

成功响应、失败响应、异步事件：

```json
{ "id": "request-uuid", "ok": true, "result": { "fileId": "upload-uuid" } }
{ "id": "request-uuid", "ok": false, "error": { "code": "authorization-required", "message": "..." } }
{ "event": { "taskId": "task-uuid", "type": "delta", "text": "正在分析" } }
```

| method | params | result |
| --- | --- | --- |
| `hello` | `{}` | `{ product: 'tandix', version: 1, taskRecovery: 1, origin, authorized, limits, mediaTypes, backends: ['codex'], resultFormats: ['text','json'] }` |
| `permissions.request` | `{}` | `{ authorized: boolean }` |
| `files.begin` | `{ name, mediaType, bytes }` | `{ fileId }` |
| `files.chunk` | `{ fileId, offset, data }` | `{ received }`，累计原始字节数 |
| `files.remove` | `{ fileId }` | `{ removed }` |
| `tasks.run` | `{ taskId, prompt, fileIds, responseFormat, timeoutMs? }` | `WebTaskSnapshot`，表示输入已落盘并被接收 |
| `tasks.get` / `tasks.attach` | `{ taskId, afterSeq?: number }` | `WebTaskSnapshot`，含事件增量和已有结果 |
| `tasks.resume` | `{ taskId, requestId, prompt? }` | `WebTaskSnapshot`，同一会话的继续操作 |
| `tasks.cancel` | `{ taskId }` | `WebTaskSnapshot`，持久终态 |

`taskId` 和恢复用的 `requestId` 使用 UUID；`fileIds` 不得重复，必须来自同一个连接并完成上传。`offset` 是原始字节偏移，从 0 连续递增。除最后一块外，原始字节数须为 3 的倍数，以便无损拼接 base64。修改类请求须等响应后再发下一个；`hello` 心跳可并发发送，避免等待用户授权时阻塞心跳。不要把任务接收快照当作 Agent 已完成。最终结果见 `snapshot.result` 或 `task.result()`。

SDK 每 20 秒发送 `hello` 心跳，每秒按游标查询任务；传输失败后以 2–10 秒退避重连，始终查询同一 taskId。自写客户端调用 `tasks.get` 观察任务，并在 `hasMore` 时立即读取下一页。仅打开空闲 Port 不代表 MV3 worker 永远存活；10 分钟没有请求会关闭观察连接，已接收任务继续执行。扩展为仍在运行的任务保留桥连接租约，后台每 5 秒核对任务状态，终止状态才释放。

## 常见错误

自动发现阶段：`discovery-timeout` 表示截止时间内没有找到可用的 Tandix，检查扩展是否安装 / 启用并刷新页面重试；`unsupported-page` 表示页面使用 `file://`、普通 HTTP 或在 iframe 中运行，需改为顶层 HTTPS / loopback 开发页面。发现失败不会触发 Agent 或上传附件。

`unavailable` / `disconnected`：扩展未安装、ID 不正确、来源不被允许、网页关闭或扩展重载。`authorization-required`：需先授权。`authorization-revoked`：授权在启动前被撤销。`unsupported-backend`：当前连接到非 Codex 后端。`unsupported-companion`：本机伴随程序未声明可恢复网页任务支持（内部协议 v2），需更新安装。`invalid-request` / `invalid-file` / `invalid-chunk` / `incomplete-upload`：入参或上传无效。`busy`：请求或任务并发超过上限。`unknown-method` / `unknown-task`：接口不存在或任务不存在 / 属于其他来源。`task-conflict`：同一个任务或恢复请求 ID 被用于不同输入。`task-busy`：原回合仍在运行或其他伴随进程持有任务；应观察原任务并重试查询。`agent-mismatch`：Agent 配置身份变化，需要恢复原配置。`session-unavailable`：创建会话时中断，无法确认原会话 ID；不会自动另建会话。`invalid-cursor`：游标不在任务事件序号范围内。`timeout`：本次尝试超时，进入 interrupted，保留原上下文可显式继续。`request-timeout`：单次协议请求 125 秒无响应，SDK 重建传输并查询原任务。`agent-error` / `agent-disconnected` / `agent-failed`：启动、连接或 Agent 执行失败。`empty-result` / `result-too-large` / `invalid-json`：最终回答无效。`cancelled`：明确取消或授权撤销。`interrupted`：原 Agent 回合中断，保留上下文等待显式继续；网页传输断连本身不改变任务状态。

## 数据与权限边界

- 仅传用户明确选择的附件与 prompt；不会隐式抓取页面 DOM、Cookie 或其他标签页。网页任务不会绑定侧栏受控标签页；Tandix 浏览器及技能工具在此任务中不可用。
- 每个新 taskId 创建持久 Codex 会话和独立工作目录，后续观察、结果补取和继续使用同一个会话；写权限限定在该目录。这里的独立目录不是完整的操作系统读隔离；Agent 的其他工具和审批仍受本机 Codex 配置约束。站点授权意味着允许该站点向你的 Agent 提交任务，应仅授权可信站点。
- 输入文件和任务状态保存于 `~/.tandix/web-tasks/<taskId>/`（Windows 为 `%USERPROFILE%\.tandix\web-tasks`），独立于安装路径和 dist。`task.json` 记录来源、后端、Agent 配置身份、原 sessionId / turnId、attempt、输入摘要、进度和结果；`work/` 是 Agent 工作目录。目录 0700、文件 0600，状态原子写入；不自动清理，使用后可由用户备份或删除。网页任务仍不加入 Tandix 侧栏会话列表。
- 文件及提示词可能被传给所选 Agent 的模型服务；站点撤销授权不会追溯删除已经传出或保存的内容。不要将模型服务不应接收的敏感材料传入。
- v1 返回文本 / JSON，不返回生成文件的二进制内容、不暴露任意本机文件读取接口，也不提供 `runSkill`、账号配置、通用 RPC、浏览器控制或自动批准接口。
- 明确取消、执行超时和撤销会尽力中断 Agent；网页断连只停止观察。已经发生的操作不自动回滚。最终结果持久保存，重复补取不会重新计算。

## 验证

协议测试覆盖来源校验、授权、PDF 分块及多图上传、跨来源恢复隔离、网页重连、回执丢失、事件回放、失败 / JSON 校验、取消 / 超时 / 撤销；伴随程序测试覆盖映射先于 prompt 落盘、重启后连续恢复、恢复请求幂等、结果补取及原工作区隔离；后台生命周期测试覆盖无侧栏启动。协议和 Agent 均有测试替身，真实 PDF 解析 / OCR / 模型效果需在安装并登录 Codex 的 Chrome 中用演示页验收。
