import { AcpBridge } from './acp-bridge.mjs'
import { ACP_AGENTS, isAdditionalAcpAgent } from './acp-agents.mjs'

/** Reuse the same ACP session, MCP tool and approval transport for each fixed backend. */
export class ExtraAcpBridge extends AcpBridge {
  constructor(options) {
    if (!isAdditionalAcpAgent(options.backend)) throw new Error('Unsupported ACP agent')
    const agent = ACP_AGENTS[options.backend]
    super({ ...options, label: agent.label, agentArgs: [...agent.args], sessionWorkspaces: options.backend === 'opencode' })
  }
  async start() {
    try {
      await super.start()
      // Check an ACP session without issuing a model prompt before claiming readiness.
      await this.rpc('connection.check', {})
    }
    catch (error) {
      const agent = ACP_AGENTS[this.backend]
      throw new Error(`${agent.label} ACP connection failed: ${error.message}. Install a CLI supporting "${agent.command} ${agent.args.join(' ')}", complete login with "${agent.login}", then reconnect.`, { cause: error })
    }
  }
}
