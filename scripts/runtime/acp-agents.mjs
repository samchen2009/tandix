/** Fixed launch targets for additional local ACP agents. No browser-supplied commands. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

export const ACP_AGENTS = Object.freeze({
  kimi: { label: 'Kimi Code', command: 'kimi', args: ['acp'], envKey: 'KIMI_AGENT_PATH', login: 'kimi' },
  qwen: { label: 'Qwen Code', command: 'qwen', args: ['--acp'], envKey: 'QWEN_AGENT_PATH', login: 'qwen' },
  opencode: { label: 'OpenCode', command: 'opencode', args: ['acp'], envKey: 'OPENCODE_AGENT_PATH', login: 'opencode auth login' },
  gemini: { label: 'Gemini CLI', command: 'gemini', args: ['--acp'], envKey: 'GEMINI_AGENT_PATH', login: 'gemini' },
})
export const isAdditionalAcpAgent = backend => Object.hasOwn(ACP_AGENTS, backend)

export function findAcpAgent(backend, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (!isAdditionalAcpAgent(backend)) throw new Error('Unsupported ACP agent')
  const { command, envKey } = ACP_AGENTS[backend]
  const usable = path => {
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      const real = realpathSync(path)
      return statSync(real).isFile() ? real : null
    } catch { return null }
  }
  const configured = env[envKey]
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(`${envKey} must be an absolute executable path.`)
    const found = usable(configured)
    if (!found) throw new Error(`${envKey} does not point to an executable ACP agent.`)
    return found
  }
  const directories = [...(env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter),
    join(home, '.local', 'bin'), join(home, '.opencode', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', join(home, 'AppData', 'Roaming', 'npm')].filter(Boolean)
  const names = platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command]
  for (const name of names) for (const directory of directories) {
    const found = usable(join(directory, name))
    if (found) return found
  }
  return null
}

/** Save only trusted installer-provided executable overrides, never account credentials. */
export function acpAgentPaths(env = process.env) {
  return Object.fromEntries(Object.entries(ACP_AGENTS).flatMap(([backend, { envKey }]) =>
    env[envKey] ? [[backend, env[envKey]]] : []))
}
