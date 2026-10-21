/** WorkBuddy/CodeBuddy discovery and ACP configuration. */
import { realpathSync, statSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { AcpBridge } from './acp-bridge.mjs'

export function findWorkBuddyAgent({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const configured = env.WORKBUDDY_AGENT_PATH
  const usable = path => {
    try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); const real = realpathSync(path); return statSync(real).isFile() ? real : null }
    catch { return null }
  }
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('WORKBUDDY_AGENT_PATH must be an absolute executable path.')
    const found = usable(configured)
    if (!found) throw new Error('WORKBUDDY_AGENT_PATH does not point to an executable ACP agent.')
    return found
  }
  const directories = [...(env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter), join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', join(home, 'AppData', 'Roaming', 'npm')].filter(Boolean)
  for (const name of platform === 'win32' ? ['codebuddy-lite-wb.exe', 'codebuddy.exe', 'codebuddy.cmd'] : ['codebuddy-lite-wb', 'codebuddy']) {
    for (const directory of directories) { const found = usable(join(directory, name)); if (found) return found }
  }
  return null
}


export class WorkBuddyBridge extends AcpBridge {
  constructor(options) {
    super({ ...options, backend: 'workbuddy', label: 'WorkBuddy', agentArgs: ['--acp'] })
  }
}
