/** Cursor CLI discovery and ACP configuration. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { AcpBridge } from './acp-bridge.mjs'

export function findCursorAgent({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const usable = path => {
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      const real = realpathSync(path)
      return statSync(real).isFile() ? real : null
    } catch { return null }
  }
  if (env.CURSOR_AGENT_PATH) {
    if (!isAbsolute(env.CURSOR_AGENT_PATH)) throw new Error('CURSOR_AGENT_PATH must be an absolute executable path.')
    const found = usable(env.CURSOR_AGENT_PATH)
    if (!found) throw new Error('CURSOR_AGENT_PATH does not point to an executable Cursor agent.')
    return found
  }
  const directories = [...(env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter),
    join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
  // Prefer the unambiguous legacy alias over another program named "agent".
  const names = platform === 'win32' ? ['cursor-agent.exe', 'cursor-agent.cmd', 'agent.exe', 'agent.cmd'] : ['cursor-agent', 'agent']
  for (const name of names) for (const directory of directories) {
    const found = usable(join(directory, name))
    if (found) return found
  }
  return null
}

export class CursorBridge extends AcpBridge {
  constructor(options) {
    super({ ...options, backend: 'cursor', label: 'Cursor', agentArgs: ['acp'], authMethod: 'cursor_login' })
  }
  async start() {
    try { await super.start() }
    catch (error) {
      throw new Error(`Cursor ACP connection failed: ${error.message}. Use a Cursor CLI that supports "agent acp"; run "agent update" and "agent login", then reconnect.`, { cause: error })
    }
  }
}
