/** Local-only design fixture. Uses the real panel with a simulated background; no agent calls. */
import manifest from '../manifest.json'
const params = new URLSearchParams(location.search)
const recording = params.get('recording') === '1'
let backend = params.get('backend') ?? 'codex'
let sessionId = 'preview-session'
const width = Math.max(320, Math.min(960, Number(params.get('width') ?? 420)))
const store: Record<string, unknown> = { dshSettings: { autoResumeSession: false, autoFollowTabs: true, agentBackend: backend }, dshUiLocale: 'zh' }
const event = () => {
  const listeners = new Set<(value: unknown) => void>()
  return { addListener: (fn: (value: unknown) => void) => listeners.add(fn), removeListener: (fn: (value: unknown) => void) => listeners.delete(fn), emit: (value: unknown) => listeners.forEach(fn => fn(value)) }
}
const onMessage = event()
let blank = params.get('empty') === '1'
const events = [
  { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我整理这个页面的要点，并告诉我接下来可以做什么。' }] } } },
  { type: 'tool/call', data: { name: 'browser_snapshot', callId: 'read', args: {} } },
  { type: 'tool/result', data: { name: 'browser_snapshot', callId: 'read', result: { ok: true, value: '页面已读取' } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我已读取当前页面，整理出以下要点。\n\n### 让网页里的工作顺畅一点\n\nTandix 可以理解当前页面，协助你完成查找、整理和填写，并把重复步骤保存为技能。\n\n1. **先理解内容**：提取关键信息，保留原始来源。\n2. **再完成操作**：根据你的目标执行，遇到需要授权的步骤会先确认。\n3. **保存为技能**：把常用流程留下，下次直接使用。\n\n你可以继续告诉我需要处理的具体内容，或选中页面中的一段文字发送过来。' }] } } },
].map((item, index) => ({ event: { ...item, seq: index + 1, time: Date.now() } }))
let chosenModel = backend === 'cursor' ? 'default' : 'gpt-6.1-sol'
let chosenEffort = 'medium'
const configuration = () => ({ backend, sessionId, source: 'session', modelId: chosenModel, modelLabel: chosenModel === 'default' ? 'auto' : chosenModel, provider: backend === 'codex' ? 'openai' : null, reasoningEffort: backend === 'codex' ? chosenEffort : null, approvalPolicy: backend === 'codex' ? 'on-request' : null, sandbox: backend === 'codex' ? 'workspaceWrite' : null })
const reply = (id: unknown, value: unknown) => onMessage.emit({ type: 'rpc.result', id, ok: true, result: { result: { ok: true, value } } })
const tab = { tabId: 1, windowId: 1, title: 'Tandix · 让网页里的工作顺畅一点', url: 'https://example.com/tandix' }
const status = () => { onMessage.emit({ type: 'status', state: 'connected', backend, caps: {} }); onMessage.emit({ type: 'session.resume-hint', sessionId: null }); onMessage.emit({ type: 'tab-affinity', state: { revision: 1, status: 'following', controlled: tab, active: tab, pinned: false } }) }
Object.assign(globalThis, { chrome: {
  runtime: { getManifest: () => ({ version: manifest.version }), getURL: (path: string) => `/${path}`, connect: () => ({ onMessage, onDisconnect: event(), postMessage: (message: Record<string, any>) => queueMicrotask(() => {
    if (message.type === 'request-status') status()
    if (message.type === 'recording.get-state') {
      onMessage.emit({ type: 'recording.result', id: message.id, ok: true, result: recording ? { phase: 'recording', recordingId: 'preview-recording' } : { phase: 'idle' } })
      if (recording) queueMicrotask(() => onMessage.emit({ type: 'recording.event', recordingId: 'preview-recording', event: {
        kind: 'click', capturedAt: Date.now(), button: 0, target: { tag: 'button', selector: '#search', name: '查询', control: 'button' },
        tab, frame: { id: 0, url: tab.url },
      } }))
    }
    if (message.type === 'settings') { Object.assign(store.dshSettings as object, message.settings); backend = message.settings.agentBackend ?? backend; onMessage.emit({ type: 'settings.result', id: message.id, ok: true }); status() }
    if (message.type === 'rpc') {
      const method = message.method
      if (method === 'agent.configuration.set') { chosenModel = message.payload.model; chosenEffort = message.payload.reasoningEffort ?? 'medium' }
      const value = method === 'session.create' ? { sessionId }
        : method === 'session.history' ? { events: blank ? [] : events, projections: { asOfSeq: 4, values: { title: '整理当前网页', modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' }, lastUsed: null } } } }
        : method === 'codex.capabilities' ? { codexHome: '~/.codex', skills: [], skillErrors: [], mcpServers: [], plugins: [], errors: [] }
        : method === 'codex.lark.status' ? { state: 'cli-missing' }
        : method === 'agent.configuration' ? configuration()
        : method === 'agent.models' ? { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }, { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] }
        : method === 'agent.configuration.set' ? { ...configuration(), saved: true, source: 'next-turn' }
        : method === 'session.modelCatalog' ? { routableProviders: ['deepseek'], groups: [{ id: 'deepseek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] }] }
        : method === 'session.selectModel' ? { selected: { provider: message.payload.provider, model: message.payload.model } }
        : method === 'settings.describe' ? { namespaces: [{ ns: 'agent-default-model', value: { provider: 'deepseek', model: 'deepseek-chat' } }] }
        : method === 'session.list' ? { items: [{ sessionId, updatedAt: Date.now(), blank, running: false, projections: { values: { title: '整理当前网页' } } }] }
        : method === 'workspace.list' ? { archivedSessionIds: [] }
        : method === 'goal.get' ? { goal: null }
        : method === 'session.prompt' ? { accepted: true }
        : {}
      reply(message.id, value)
      if (method === 'session.prompt' && recording) {
        onMessage.emit({ type: 'event', frame: { t: 'event', frame: { rpcId: '', method: 'session/event', payload: { sessionId, event: { type: 'turn/start', data: {}, seq: 5 } } } } })
        setTimeout(() => {
          const draft = { schemaVersion: 'tandix.skill-pair/v1', name: '查询网页信息', browserSkill: {
            goal: '在当前网页查询所需信息', steps: ['打开目标页面', '点击查询按钮', '核对页面中的查询结果'],
            success: '页面显示符合查询条件的结果', parameters: [], allowedOrigins: ['https://example.com'], startUrl: tab.url,
          }, desktopSkill: null, questions: [] }
          for (const event of [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `<tandix-skill-pair-json>${JSON.stringify(draft)}</tandix-skill-pair-json>` }] } }, seq: 6 }, { type: 'turn/end', data: {}, seq: 7 }]) {
            onMessage.emit({ type: 'event', frame: { t: 'event', frame: { rpcId: '', method: 'session/event', payload: { sessionId, event } } } })
          }
        }, 5000)
      }
    }
  }) }) },
  storage: { local: { get: async (key: string) => typeof key === 'string' ? { [key]: store[key] } : store, set: async (values: object) => Object.assign(store, values), remove: async () => {} }, onChanged: event() },
  windows: { getCurrent: async () => ({ id: 1 }) }, tabs: { create: async () => {} },
} })
await import('../src/panel/main.tsx')
const style = document.createElement('style')
style.textContent = `body{background:#dfe6e1}#root{width:min(100vw,${width}px);height:100dvh;margin:0 auto;box-shadow:0 0 45px #16332210}.app{height:100%}.menu-dismiss{max-width:none}`
document.head.append(style)
