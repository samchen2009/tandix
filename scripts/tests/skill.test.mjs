import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../cli/skill.mjs', import.meta.url))

const skill = {
  schemaVersion: 'tandix.agent-skill/v1', version: 1, id: 'skill-1',
  name: 'Feedback search', goal: 'Find feedback', steps: ['Search by {{keyword}}'], success: 'Results returned',
  parameters: [{ name: 'keyword', label: 'Keyword', type: 'string', required: true }],
  allowedOrigins: ['https://example.com'], startUrl: 'https://example.com/feedback',
  desktopAdapter: { kind: 'http', auth: { kind: 'bearer-env', env: 'FEEDBACK_TOKEN' },
    requests: [{ name: 'search', method: 'GET', url: 'https://example.com/api/search', query: { keyword: '{{keyword}}' } }] },
  sourceSessionId: '', createdAt: 1,
}

test('prompt-run selects desktop instructions for agent-runtime tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tandix-skill-cli-'))
  try {
    const skillPath = join(root, 'skill.json')
    const taskPath = join(root, 'task.json')
    await writeFile(skillPath, JSON.stringify(skill))
    await writeFile(taskPath, JSON.stringify({
      schemaVersion: 'tandix.agent-task/v1', id: 'task-1', skillId: skill.id, skillVersion: 1,
      inputs: { keyword: 'projection' }, target: { kind: 'agent-runtime' }, requestedAt: 1,
    }))
    const { stdout } = await execFileAsync(process.execPath, [cli, 'prompt-run', '--skill', skillPath, '--task', taskPath])
    assert.match(stdout, /Tandix-derived command-line skill on a desktop Agent/u)
    assert.doesNotMatch(stdout, /browser_list_tabs/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prompt-extract allows a reviewed browser-only skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tandix-skill-extract-'))
  try {
    const evidencePath = join(root, 'evidence.txt')
    await writeFile(evidencePath, 'Opened the page and queried feedback.')
    const { stdout } = await execFileAsync(process.execPath, [cli, 'prompt-extract', '--evidence', evidencePath])
    assert.match(stdout, /browser-only skill can be complete without an adapter question/u)
    assert.match(stdout, /browser-independent execution is optional/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
