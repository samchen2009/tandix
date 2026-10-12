// @vitest-environment jsdom
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatSkill } from '../src/skill/chat-skill.ts'
import {
  createSkillArchive,
  renderDesktopRunScript,
  renderExecutionModesReference,
  renderSkillMarkdown,
} from '../src/skill/skill-archive.ts'

const skill: ChatSkill = {
  schemaVersion: 'tandix.agent-skill/v1',
  version: 1,
  id: 'skill-12345678',
  name: '查询用户反馈',
  goal: '按关键词查询反馈并汇总结果',
  steps: ['输入 {{keyword}}', '执行查询', '汇总结果'],
  success: '查询结果和汇总均已输出',
  parameters: [{ name: 'keyword', label: '内容关键词', type: 'string', required: true }],
  allowedOrigins: ['https://example.com'],
  startUrl: 'https://example.com/feedback',
  sourceSessionId: 'session-1',
  createdAt: 1,
}

function runNode(scriptPath: string, input: string, preloadPath?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preloadPath === undefined ? [] : ['--import', preloadPath]), scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code, stdout, stderr }) })
    child.stdin.end(input)
  })
}

describe('portable skill archive', () => {
  it('does not claim desktop execution or bundle a script without a reviewed adapter', () => {
    const markdown = renderSkillMarkdown(skill, 'feedback-search')
    expect(markdown).toContain('browser-only skill')
    expect(markdown).toContain('no reviewed command-line adapter')
    expect(markdown).not.toContain('scripts/run.mjs')
    expect(markdown).toContain('historical element indices and selectors are not reusable')
    expect(markdown).not.toContain('session-1')

    const reference = renderExecutionModesReference(skill)
    expect(reference).toContain('must not be presented as a desktop automation skill')
    expect(reference).toContain('Do not infer or call undocumented private endpoints')

    const archive = createSkillArchive(skill)
    const raw = new TextDecoder().decode(archive.bytes)
    expect(raw).toContain('/SKILL.md')
    expect(raw).not.toContain('/scripts/run.mjs')
    expect(raw).toContain('/references/execution-modes.md')
    expect(raw).toContain('/references/tandix-skill.json')
  })

  it('bundles and executes a reviewed command-line HTTP adapter', async () => {
    const desktopSkill: ChatSkill = {
      ...skill,
      parameters: [{ name: 'keyword', label: '内容关键词', type: 'string', required: false, defaultValue: '投屏' }],
      desktopAdapter: {
        kind: 'http', auth: { kind: 'none' },
        requests: [{
          name: 'feedback', method: 'GET', url: 'https://example.com/api/feedback',
          query: { keyword: '{{keyword}}', start: '{{time:yesterday-start-ms}}' },
          response: { listPath: 'data.list' },
        }],
      },
    }
    const root = await mkdtemp(join(tmpdir(), 'tandix-portable-skill-'))
    try {
      await mkdir(join(root, 'scripts'))
      await mkdir(join(root, 'references'))
      const scriptPath = join(root, 'scripts', 'run.mjs')
      const preloadPath = join(root, 'mock-fetch.mjs')
      await writeFile(scriptPath, renderDesktopRunScript())
      await writeFile(join(root, 'references', 'tandix-skill.json'), JSON.stringify(desktopSkill))
      await writeFile(preloadPath, `globalThis.fetch = async (url, init) => new Response(JSON.stringify({
  data: { list: [{ id: 1 }] }, total: 1, requestedUrl: String(url), method: init.method,
}), { status: 200, headers: { 'content-type': 'application/json' } })\n`)
      const result = await runNode(scriptPath, JSON.stringify({}), preloadPath)
      expect(result.code, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output).toMatchObject({
        skillId: skill.id,
        results: [{ name: 'feedback', status: 200, itemCount: 1, data: { total: 1 } }],
      })
      const requestedUrl = new URL(output.results[0].data.requestedUrl)
      expect(requestedUrl.searchParams.get('keyword')).toBe('投屏')
      expect(Number(requestedUrl.searchParams.get('start'))).toBeGreaterThan(0)
      const archive = new TextDecoder().decode(createSkillArchive(desktopSkill).bytes)
      expect(archive).toContain('/scripts/run.mjs')
      expect(renderSkillMarkdown(desktopSkill)).toContain('default: "投屏"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
