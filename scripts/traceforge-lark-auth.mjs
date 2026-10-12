/** Device authorization for the official lark-cli. Secrets never cross the browser bridge. */

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_OUTPUT_BYTES = 64 * 1024
const AUTH_TIMEOUT_MS = 25_000

function safeLarkUrl(value) {
  if (typeof value !== 'string') throw new Error('Feishu did not return an authorization link')
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['feishu.cn', 'larksuite.com'].some(domain =>
    url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('Feishu returned an unexpected authorization link')
  }
  return value
}

function parseJson(text) {
  try { return JSON.parse(text.trim()) }
  catch { throw new Error('Could not read the Feishu CLI response') }
}

function cliError(text) {
  let result
  try { result = parseJson(text) } catch { /* Avoid echoing untrusted output or credentials. */ }
  const message = result?.error?.message ?? ''
  if (/keychain|config|app.?id|app.?secret/iu.test(message)) {
    return new Error('Feishu CLI is not configured. Run lark-cli config init --new in your local terminal, then retry.')
  }
  if (/expired|device.?code/iu.test(message)) return new Error('The Feishu authorization expired. Start a new login.')
  return new Error('Feishu authorization did not complete. Check the account and app permissions, then retry.')
}

function larkCliPath() {
  const candidates = [
    '/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli',
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map(directory => join(directory, 'lark-cli')),
  ]
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* Try the next location. */ }
  }
  return 'lark-cli'
}

export function runLarkCli(args, { cwd, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(larkCliPath(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    })
    let stdout = ''
    let stderr = ''
    let finished = false
    const settle = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(new Error('Feishu CLI timed out. Try again.'))
    }, timeoutMs)
    const collect = (stream, set) => stream.on('data', chunk => {
      set(chunk.toString('utf8'))
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        child.kill()
        settle(new Error('Feishu CLI returned too much output'))
      }
    })
    collect(child.stdout, chunk => { stdout += chunk })
    collect(child.stderr, chunk => { stderr += chunk })
    child.on('error', error => settle(error.code === 'ENOENT'
      ? new Error('lark-cli is not installed. Install the official Feishu CLI first.')
      : new Error('Could not start Feishu CLI')))
    child.on('close', code => settle(null, { code, stdout, stderr }))
  })
}

export class LarkAuth {
  constructor({ cwd, run = runLarkCli, makeQr = null }) {
    this.cwd = cwd
    this.run = run
    this.makeQr = makeQr ?? (url => this.qrCode(url))
    this.pending = null
  }

  async status() {
    try {
      const help = await this.run(['docs', '+update', '--help'], { cwd: this.cwd })
      if (help.code !== 0 || !help.stdout.includes('--command') || !help.stdout.includes('--doc-format')) {
        return { state: 'cli-outdated' }
      }
      const result = await this.run(['auth', 'status', '--json', '--verify'], { cwd: this.cwd })
      if (result.code !== 0) return { state: 'setup-required' }
      const data = parseJson(result.stdout)
      const user = data.identities?.user ?? data.data?.identities?.user
      return {
        state: data.ok !== false && data.verified !== false && user?.status === 'ready'
          && user?.tokenStatus !== 'expired' ? 'connected' : 'login-required',
        userName: typeof user?.userName === 'string' ? user.userName : null,
      }
    } catch (error) {
      return { state: /not installed/iu.test(error.message) ? 'cli-missing' : 'setup-required' }
    }
  }

  async qrCode(url) {
    const directory = mkdtempSync(join(tmpdir(), 'tandix-lark-auth-'))
    try {
      const result = await this.run(['auth', 'qrcode', url, '--output', 'authorization.png'], { cwd: directory })
      if (result.code !== 0) return null
      const path = join(directory, 'authorization.png')
      if (statSync(path).size > 1024 * 1024) return null
      return `data:image/png;base64,${readFileSync(path).toString('base64')}`
    } catch { return null }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }

  async start() {
    const help = await this.run(['docs', '+update', '--help'], { cwd: this.cwd })
    if (help.code !== 0 || !help.stdout.includes('--command') || !help.stdout.includes('--doc-format')) {
      throw new Error('lark-cli is too old for the installed lark-doc Skill. Run lark-cli update first.')
    }
    const result = await this.run(['auth', 'login', '--domain', 'docs', '--no-wait', '--json'], { cwd: this.cwd })
    if (result.code !== 0) throw cliError(result.stderr)
    const data = parseJson(result.stdout)
    const authorizationUrl = safeLarkUrl(data.verification_url ?? data.verification_uri_complete)
    if (typeof data.device_code !== 'string' || data.device_code.length === 0) {
      throw new Error('Feishu did not return a device authorization code')
    }
    const expiresIn = Math.max(60, Math.min(Number(data.expires_in) || 600, 3600))
    this.pending = { deviceCode: data.device_code, expiresAt: Date.now() + expiresIn * 1000 }
    const qrCodeDataUrl = await this.makeQr(authorizationUrl)
    return { authorizationUrl, qrCodeDataUrl, expiresIn }
  }

  async complete() {
    if (this.pending === null || this.pending.expiresAt <= Date.now()) {
      this.pending = null
      throw new Error('Feishu authorization expired. Start a new login.')
    }
    const result = await this.run(['auth', 'login', '--device-code', this.pending.deviceCode], {
      cwd: this.cwd, timeoutMs: AUTH_TIMEOUT_MS,
    })
    if (result.code !== 0) throw cliError(result.stderr)
    this.pending = null
    const status = await this.status()
    if (status.state !== 'connected') throw new Error('Feishu login finished, but user access could not be verified')
    return status
  }
}
