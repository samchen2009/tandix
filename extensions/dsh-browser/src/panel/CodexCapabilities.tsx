import { useEffect, useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { PanelApi } from './api.ts'

interface CapabilitySnapshot {
  codexHome: string
  skills: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean; pluginId: string | null }>
  skillErrors: Array<{ message?: string; path?: string }>
  mcpServers: Array<{ name: string; status: string | null; authStatus: string; tools: string[]; error: string | null }>
  plugins: Array<{ id: string; name: string; marketplace: string; marketplacePath: string | null;
    remoteMarketplaceName: string | null; installed: boolean; enabled: boolean; availability: string; description: string }>
  errors: string[]
}

type PluginInstallState = { status: 'installing' | 'installed' | 'error'; message?: string; needsAuth?: boolean }
type LarkStatus = { state: 'connected' | 'login-required' | 'setup-required' | 'cli-missing' | 'cli-outdated'; userName?: string | null }
type LarkAuthorization = { authorizationUrl: string; qrCodeDataUrl: string | null; expiresIn: number }

export function CodexCapabilities({ api, sessionId, locale }: {
  api: PanelApi
  sessionId: string | null
  locale: UiLocale
}): React.JSX.Element {
  const zh = locale === 'zh'
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [pluginSearch, setPluginSearch] = useState('')
  const [pluginInstalls, setPluginInstalls] = useState<Record<string, PluginInstallState>>({})
  const installingPluginIds = useRef(new Set<string>())
  const [larkStatus, setLarkStatus] = useState<LarkStatus | null>(null)
  const [larkAuthorization, setLarkAuthorization] = useState<LarkAuthorization | null>(null)
  const [larkBusy, setLarkBusy] = useState(false)
  const [larkError, setLarkError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      setSnapshot(await api.rpc<CapabilitySnapshot>('codex.capabilities', { sessionId }))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    void refresh()
    void api.rpc<LarkStatus>('codex.lark.status').then(setLarkStatus).catch(() => setLarkStatus(null))
    const off = api.onEvent((frame) => {
      if (frame.t === 'event' && frame.frame.method === 'codex/capabilities-changed') void refresh()
    })
    return off
  }, [api, sessionId])

  async function startLarkLogin(): Promise<void> {
    setLarkBusy(true)
    setLarkError('')
    try {
      const result = await api.rpc<LarkAuthorization>('codex.lark.login.start')
      const url = new URL(result.authorizationUrl)
      if (url.protocol !== 'https:' || !['feishu.cn', 'larksuite.com'].some(domain =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('Invalid Feishu authorization URL')
      setLarkAuthorization(result)
      await chrome.tabs.create({ url: result.authorizationUrl })
    } catch (cause) { setLarkError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLarkBusy(false) }
  }

  async function completeLarkLogin(): Promise<void> {
    setLarkBusy(true)
    setLarkError('')
    try {
      const status = await api.rpc<LarkStatus>('codex.lark.login.complete')
      setLarkStatus(status)
      setLarkAuthorization(null)
    } catch (cause) { setLarkError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLarkBusy(false) }
  }

  async function run(operation: () => Promise<void>, success: string): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try { await operation(); setNotice(success); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  async function installPlugin(plugin: CapabilitySnapshot['plugins'][number]): Promise<void> {
    if (installingPluginIds.current.has(plugin.id)) return
    installingPluginIds.current.add(plugin.id)
    setPluginInstalls(current => ({ ...current, [plugin.id]: { status: 'installing' } }))
    try {
      const result = await api.rpc<{ appsNeedingAuth?: unknown[] }>('codex.plugin.install', { name: plugin.name,
        ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath }
          : { remoteMarketplaceName: plugin.remoteMarketplaceName }) })
      setPluginInstalls(current => ({ ...current, [plugin.id]: {
        status: 'installed', needsAuth: (result?.appsNeedingAuth?.length ?? 0) > 0,
      } }))
      void refresh()
    } catch (cause) {
      setPluginInstalls(current => ({ ...current, [plugin.id]: {
        status: 'error', message: cause instanceof Error ? cause.message : String(cause),
      } }))
    } finally {
      installingPluginIds.current.delete(plugin.id)
    }
  }

  const listedPlugins = (snapshot?.plugins ?? [])
    .filter(plugin => (plugin.installed || plugin.availability === 'AVAILABLE')
      && `${plugin.name} ${plugin.description}`.toLowerCase().includes(pluginSearch.toLowerCase()))
    .slice(0, 12)
  const installedPluginCount = (snapshot?.plugins ?? [])
    .filter(plugin => plugin.installed || pluginInstalls[plugin.id]?.status === 'installed').length

  return <section className="codex-capabilities" aria-label={zh ? 'Codex 扩展能力' : 'Codex extensions'}>
    <div className="codex-capabilities-heading">
      <div><strong>{zh ? 'Skills、MCP 与 Plugins' : 'Skills, MCP and plugins'}</strong>
        <small>{zh ? '由当前 Codex 环境提供；新增能力请开启新会话。' : 'Provided by this Codex environment; start a new session after installing.'}</small>
        {snapshot?.codexHome && <small>CODEX_HOME: {snapshot.codexHome}</small>}</div>
      <button type="button" disabled={loading || busy} onClick={() => { void refresh() }}>
        {loading ? (zh ? '刷新中…' : 'Refreshing…') : (zh ? '刷新' : 'Refresh')}
      </button>
    </div>
    {error !== '' && <p className="codex-capabilities-error" role="alert">{error}</p>}
    {notice !== '' && <p className="codex-capabilities-notice" role="status">{notice}</p>}
    {(snapshot?.errors ?? []).map((entry, index) => <p className="codex-capabilities-error" key={index}>{entry}</p>)}

    <div className="codex-capabilities-group">
      <h2>Skills <small>{snapshot?.skills.length ?? 0}</small></h2>
      {(snapshot?.skills ?? []).length === 0 && <p>{zh ? '未发现 Codex Skill。' : 'No Codex skills found.'}</p>}
      {(snapshot?.skills ?? []).map(skill => <div className="codex-capability-item" key={skill.path}>
        <span><strong>{skill.name}</strong><small>{skill.scope}{skill.pluginId ? ` · ${skill.pluginId}` : ''}</small>
          <small>{skill.description}</small></span>
        <button type="button" disabled={busy || skill.scope === 'system' || skill.scope === 'admin'}
          onClick={() => { void run(async () => {
            await api.rpc('codex.skills.enable', { path: skill.path, enabled: !skill.enabled })
          }, zh ? 'Skill 设置已更新。' : 'Skill setting updated.') }}>
          {skill.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '启用' : 'Enable')}
        </button>
      </div>)}
      {(snapshot?.skillErrors ?? []).map((entry, index) =>
        <p className="codex-capabilities-error" key={index}>{entry.path ? `${entry.path}: ` : ''}{entry.message ?? JSON.stringify(entry)}</p>)}
      {(snapshot?.skills ?? []).some(skill => skill.name === 'lark-doc') && <div className="codex-lark-login">
        <div className="codex-lark-login-heading"><strong>{zh ? '飞书文档授权' : 'Feishu Docs authorization'}</strong>
          <small>{larkStatus?.state === 'connected'
            ? (zh ? `已连接${larkStatus.userName ? ` · ${larkStatus.userName}` : ''}`
              : `Connected${larkStatus.userName ? ` · ${larkStatus.userName}` : ''}`)
            : larkStatus?.state === 'cli-missing'
              ? (zh ? '需要安装飞书官方 lark-cli' : 'Install the official lark-cli first')
              : larkStatus?.state === 'cli-outdated'
                ? (zh ? '飞书 CLI 版本与 Skill 不兼容' : 'Feishu CLI is incompatible with this skill')
              : larkStatus?.state === 'setup-required'
                ? (zh ? '需要先配置飞书应用' : 'Feishu app setup required')
                : (zh ? '等待用户授权' : 'User authorization required')}</small></div>
        {larkStatus?.state === 'setup-required' && <p>{zh
          ? '请先在本机终端运行 lark-cli config init --new，按飞书页面完成应用配置；不要把 App Secret 填入网页助手。'
          : 'Run lark-cli config init --new in a local terminal and finish app setup in Feishu. Do not paste an App Secret into Tandix.'}</p>}
        {larkStatus?.state === 'cli-missing' && <p>{zh
          ? '请先在本机终端运行 npx @larksuite/cli@latest install，再返回刷新。'
          : 'Run npx @larksuite/cli@latest install in a local terminal, then refresh.'}</p>}
        {larkStatus?.state === 'cli-outdated' && <p>{zh
          ? '当前 CLI 缺少 lark-doc 所需的新版编辑接口。请在本机终端运行 lark-cli update，完成后刷新。'
          : 'This CLI lacks the editing interface required by lark-doc. Run lark-cli update locally, then refresh.'}</p>}
        {larkStatus?.state !== 'connected' && larkStatus?.state !== 'cli-missing' && larkStatus?.state !== 'cli-outdated' && <button type="button"
          disabled={larkBusy} onClick={() => { void startLarkLogin() }}>
          {larkBusy && !larkAuthorization ? (zh ? '正在发起…' : 'Starting…') : (zh ? '连接飞书文档' : 'Connect Feishu Docs')}
        </button>}
        {larkAuthorization && <div className="codex-lark-authorization" role="status">
          <p>{zh ? '请在打开的飞书页面完成授权，再点击下方按钮。' : 'Authorize in the opened Feishu tab, then confirm below.'}</p>
          <a href={larkAuthorization.authorizationUrl} target="_blank" rel="noopener noreferrer">
            {zh ? '打开飞书授权链接' : 'Open Feishu authorization link'}</a>
          {larkAuthorization.qrCodeDataUrl
            ? <img src={larkAuthorization.qrCodeDataUrl} alt={zh ? '飞书授权二维码' : 'Feishu authorization QR code'} />
            : <small>{zh ? '当前 CLI 不支持生成二维码；可使用上方链接完成授权。' : 'This CLI cannot generate a QR code; use the link above.'}</small>}
          <button type="button" disabled={larkBusy} onClick={() => { void completeLarkLogin() }}>
            {larkBusy ? (zh ? '验证中…' : 'Verifying…') : (zh ? '已完成授权，验证连接' : 'I authorized, verify connection')}
          </button>
        </div>}
        {larkError && <p className="codex-capabilities-error" role="alert">{larkError}</p>}
        <small>{zh ? '仅请求文档权限；临时授权码只保存在本地进程内。' : 'Requests Docs access only; the temporary device code stays in the local process.'}</small>
      </div>}
      <p>{zh ? '安装独立 Skill 可在聊天中让 Codex 使用 skill-installer；安装后点击刷新。' : 'To install a standalone skill, ask Codex to use skill-installer in chat, then refresh.'}</p>
    </div>

    <div className="codex-capabilities-group">
      <h2>MCP <small>{snapshot?.mcpServers.length ?? 0}</small></h2>
      {(snapshot?.mcpServers ?? []).map(server => <div className="codex-capability-item" key={server.name}>
        <span><strong>{server.name}</strong><small>{server.status ?? 'unknown'} · {server.authStatus} · {server.tools.length} tools</small>
          {server.error && <small className="codex-capabilities-error">{server.error}</small>}</span>
        {(server.authStatus === 'notLoggedIn' || server.status === 'authenticationRequired') && <button type="button" disabled={busy}
          onClick={() => { void run(async () => {
            const result = await api.rpc<{ authorizationUrl: string }>('codex.mcp.login', { name: server.name, sessionId })
            const authUrl = new URL(result.authorizationUrl)
            if (!['https:', 'http:'].includes(authUrl.protocol)) throw new Error('Invalid authorization URL')
            await chrome.tabs.create({ url: authUrl.toString() })
          }, zh ? '已打开登录页面；完成授权后会自动刷新。' : 'Login opened; the list refreshes after authorization.') }}>
          {zh ? '连接' : 'Connect'}
        </button>}
      </div>)}
      <form className="codex-mcp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await api.rpc('codex.mcp.add', { name, transport,
          ...(transport === 'http' ? { url } : { command, args: args.split('\n').map(value => value.trim()).filter(Boolean) }) })
        setName(''); setUrl(''); setCommand(''); setArgs('')
      }, zh ? 'MCP 已添加；请开启新会话使用。' : 'MCP server added; start a new session to use it.') }}>
        <strong>{zh ? '添加 MCP Server' : 'Add MCP server'}</strong>
        <input aria-label={zh ? 'MCP 名称' : 'MCP name'} placeholder={zh ? '名称，例如 docs' : 'Name, e.g. docs'}
          value={name} onChange={event => setName(event.target.value)} required />
        <select aria-label={zh ? '连接方式' : 'Transport'} value={transport}
          onChange={event => setTransport(event.target.value as 'http' | 'stdio')}>
          <option value="http">HTTP</option><option value="stdio">stdio</option>
        </select>
        {transport === 'http'
          ? <input aria-label="MCP URL" type="url" placeholder="https://example.com/mcp" value={url}
              onChange={event => setUrl(event.target.value)} required />
          : <><input aria-label={zh ? '启动命令' : 'Command'} placeholder={zh ? '启动命令' : 'Command'} value={command}
              onChange={event => setCommand(event.target.value)} required />
            <textarea aria-label={zh ? '命令参数' : 'Arguments'} placeholder={zh ? '每行一个参数' : 'One argument per line'}
              value={args} onChange={event => setArgs(event.target.value)} /></>}
        <button type="submit" disabled={busy}>{zh ? '添加' : 'Add'}</button>
      </form>
    </div>

    <div className="codex-capabilities-group">
      <h2>Plugins <small>{installedPluginCount}</small></h2>
      <input aria-label={zh ? '搜索插件' : 'Search plugins'} placeholder={zh ? '搜索插件' : 'Search plugins'}
        value={pluginSearch} onChange={event => setPluginSearch(event.target.value)} />
      {listedPlugins.map(plugin => {
        const install = pluginInstalls[plugin.id]
        const installing = install?.status === 'installing'
        const installed = !installing && (plugin.installed || install?.status === 'installed')
        const failed = !installed && install?.status === 'error'
        return <div className={`codex-capability-item codex-plugin-item${installed ? ' is-installed' : ''}${failed ? ' has-error' : ''}`}
          key={plugin.id} aria-busy={installing}>
          <span><strong>{plugin.name}</strong><small>{plugin.description || plugin.marketplace}</small>
            {installing && <small className="codex-plugin-status" role="status">{zh ? '正在安装…' : 'Installing…'}</small>}
            {installed && <small className="codex-plugin-status" role="status">
              {install?.needsAuth
                ? (zh ? '安装完成 · 还需连接账号' : 'Installed · account connection needed')
                : (zh ? '安装完成 · 新会话可用' : 'Installed · available in new sessions')}</small>}
            {failed && <small className="codex-capabilities-error" role="alert">
              {zh ? '安装失败：' : 'Installation failed: '}{install.message}</small>}
          </span>
          {installed ? <span className="codex-plugin-installed" aria-label={zh ? '已安装' : 'Installed'}>
            <span aria-hidden="true">✓</span>{zh ? '已安装' : 'Installed'}
          </span> : <button type="button" className={`codex-plugin-install${installing ? ' is-installing' : ''}${failed ? ' is-retry' : ''}`}
            disabled={installing} aria-label={installing
              ? (zh ? `正在安装 ${plugin.name}` : `Installing ${plugin.name}`)
              : failed ? (zh ? `重试安装 ${plugin.name}` : `Retry installing ${plugin.name}`)
                : (zh ? `安装 ${plugin.name}` : `Install ${plugin.name}`)}
            onClick={() => { void installPlugin(plugin) }}>
            {installing ? <span className="codex-plugin-spinner" aria-hidden="true" />
              : failed ? (zh ? '重试' : 'Retry') : (zh ? '安装' : 'Install')}
          </button>}
        </div>
      })}
    </div>
  </section>
}
