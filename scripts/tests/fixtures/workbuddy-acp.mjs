#!/usr/bin/env node
// ACP test double: no model, credentials, or external services.
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
const cursor = process.argv[2] === 'acp'
if (!cursor && process.argv[2] !== '--acp') throw new Error('Incorrect ACP launch arguments')
let authenticated = !cursor
const sessions = new Map()
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  const reply = result => send({ id: message.id, result })
  if (message.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } })
  else if (message.method === 'authenticate') {
    if (!cursor || message.params.methodId !== 'cursor_login') throw new Error('Incorrect ACP authentication')
    authenticated = true; reply({})
  } else if (message.method === 'session/new') {
    if (!authenticated) throw new Error('Cursor authentication must precede session/new')
    const sessionId = `fixture-${sessions.size + 1}`
    sessions.set(sessionId, message.params.mcpServers[0]); reply({ sessionId })
  } else if (message.method === 'session/prompt') {
    const config = sessions.get(message.params.sessionId)
    const require = createRequire(config.args[1])
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
    const client = new Client({ name: 'acp-fixture', version: '1' })
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args }))
      const result = await client.callTool({ name: 'browser_snapshot', arguments: {} })
      send({ method: 'session/update', params: { sessionId: message.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.content[0].text } } } })
      reply({ stopReason: 'end_turn' })
    } finally { await client.close() }
  } else if (message.method === 'session/load') {
    sessions.set(message.params.sessionId, message.params.mcpServers[0]); reply({})
  } else if (message.id !== undefined) reply({})
})
