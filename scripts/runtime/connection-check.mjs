/** Verify native messaging, backend identity, WebSocket authentication and a harmless RPC. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function checkConnection({ executable, args = [], backend, extensionId, runtimePath,
  timeoutMs = 90_000, env = process.env }) {
  let child
  let socket
  let timer
  let diagnostic = ''
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${backend}: connection check timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000) })
      const ready = new Promise((accept, reject) => {
        let pending = Buffer.alloc(0)
        child.once('error', reject)
        child.once('exit', code => reject(new Error(`${backend}: native companion exited (${code}). ${diagnostic}`)))
        child.stdin.on('error', reject)
        child.stdout.on('data', chunk => {
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= 4) {
            const length = pending.readUInt32LE(0)
            if (length > 1024 * 1024) { reject(new Error('Invalid native messaging response')); return }
            if (pending.length < length + 4) return
            let frame
            try { frame = JSON.parse(pending.subarray(4, 4 + length).toString('utf8')) }
            catch { reject(new Error('Native companion returned invalid JSON')); return }
            pending = pending.subarray(4 + length)
            if (frame.type === 'error') reject(new Error(String(frame.message || 'Native companion failed')))
            else if (frame.type === 'ready') accept(frame)
          }
        })
      })
      const message = Buffer.from(JSON.stringify({ type: 'ensure', backend }))
      const header = Buffer.alloc(4)
      header.writeUInt32LE(message.length)
      child.stdin.write(Buffer.concat([header, message]))
      const frame = await ready
      const target = new URL(frame.wsUrl)
      if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.pathname !== '/ext/bridge') {
        throw new Error('Native companion returned an invalid local bridge URL')
      }
      const configUrl = new URL(target)
      configUrl.protocol = 'http:'
      configUrl.pathname = '/ext/bridge-config'
      const response = await fetch(configUrl, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`Bridge discovery returned HTTP ${response.status}`)
      const config = await response.json()
      if ((config.backend ?? 'dsh') !== backend || config.wsUrl !== target.href) throw new Error('Bridge backend identity does not match the requested agent')
      const { WebSocket } = createRequire(realpathSync(runtimePath))('ws')
      socket = new WebSocket(target.href, { origin: `chrome-extension://${extensionId}`, handshakeTimeout: 10_000 })
      // Keep a queue: replies can arrive before the caller starts awaiting the next frame.
      const frames = []
      let wake
      let failure
      socket.on('message', raw => {
        try {
          const value = JSON.parse(raw.toString())
          if (value.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }))
          else { frames.push(value); wake?.() }
        }
        catch { failure = new Error('Bridge returned invalid JSON'); wake?.() }
      })
      socket.on('error', error => { failure = error; wake?.() })
      socket.on('close', () => { failure ??= new Error('Bridge disconnected during its connection check'); wake?.() })
      const next = async predicate => {
        while (true) {
          if (failure) throw failure
          const error = frames.find(value => value.t === 'error')
          if (error) throw new Error(error.message || error.error?.message || 'Bridge rejected the connection')
          const match = frames.findIndex(predicate)
          if (match >= 0) return frames.splice(match, 1)[0]
          await new Promise(accept => { wake = accept })
        }
      }
      await new Promise((accept, reject) => { socket.once('open', accept); socket.once('error', reject) })
      socket.send(JSON.stringify({ t: 'hello', token: '', caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 } }))
      await next(value => value.t === 'hello.ok')
      const id = 'tandix-install-check'
      socket.send(JSON.stringify({ t: 'rpc', id, method: 'session.list', payload: {} }))
      const result = await next(value => value.t === 'rpc.result' && value.id === id)
      if (result.ok !== true || result.result?.result?.ok !== true || !Array.isArray(result.result?.result?.value?.items)) {
        throw new Error(result.error?.message || result.result?.result?.error?.message || 'Agent session-list check failed')
      }
      const checks = ['native-messaging', 'backend-identity', 'websocket-hello', 'session-list']
      if (backend === 'workbuddy' || backend === 'cursor') {
        socket.send(JSON.stringify({ t: 'rpc', id: 'tandix-install-auth', method: 'connection.check', payload: {} }))
        const auth = await next(value => value.t === 'rpc.result' && value.id === 'tandix-install-auth')
        if (auth.ok !== true || auth.result?.result?.ok !== true || auth.result?.result?.value?.authenticated !== true) {
          throw new Error(auth.error?.message || auth.result?.result?.error?.message || `${backend} CLI authentication check failed`)
        }
        checks.push('acp-session-authentication')
      }
      return { backend, status: 'ready', checks }
    })()])
  } finally {
    clearTimeout(timer)
    socket?.terminate()
    // EOF lets the native companion close its own agent processes cleanly.
    if (child && child.exitCode === null) {
      child.stdin.end()
      const killTimer = setTimeout(() => child.kill(), 3000)
      await new Promise(accept => { child.once('exit', accept); setTimeout(accept, 3500).unref() })
      clearTimeout(killTimer)
    }
  }
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, []))
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
  const extensionId = manifest.allowed_origins?.[0]?.match(/^chrome-extension:\/\/([a-p]{32})\/$/)?.[1]
  if (!extensionId) throw new Error('Native host manifest has no valid extension allowlist')
  let result
  try {
    result = await checkConnection({ executable: manifest.path, backend: options.backend, extensionId,
      runtimePath: options.runtime, timeoutMs: options.timeout ? Number(options.timeout) : 90_000 })
    console.log(`[OK] ${result.backend}: native messaging + WebSocket + session list`)
  } catch (error) {
    result = { backend: options.backend, status: 'failed', message: error.message }
    console.error(`[FAILED] ${options.backend}: ${error.message}`)
    process.exitCode = 1
  }
  if (options.report) writeFileSync(options.report, JSON.stringify(result, null, 2) + '\n')
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
