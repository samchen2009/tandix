#!/usr/bin/env node
/** Provider-neutral Tandix skill prompt/JSON workflow. Does not call an AI API. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const promptDir = new URL('../prompts/', import.meta.url)
const [command, ...args] = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function fail(message) {
  throw new Error(message)
}

function parseJson(text) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''))
}

function validOrigin(origin) {
  if (typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin
  } catch { return false }
}

function validStartUrl(value, allowedOrigins) {
  if (value === undefined) return true
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
      && !url.pathname.split('/').includes(':id')
      && allowedOrigins.includes(url.origin)
  } catch { return false }
}

const desktopTimeTokens = new Set([
  'yesterday-start-iso', 'today-end-iso', 'yesterday-start-ms',
  'today-end-ms', 'yesterday-start-s', 'today-end-s',
])

function validDesktopValues(value, parameters) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 100) return false
  const names = new Set(parameters.map(parameter => parameter.name))
  return Object.entries(value).every(([key, item]) => key && key.length <= 200
    && ['string', 'number', 'boolean'].includes(typeof item)
    && (typeof item !== 'string' || [...item.matchAll(/\{\{([^{}]+)\}\}/gu)].every((match) =>
      names.has(match[1]) || (match[1].startsWith('time:') && desktopTimeTokens.has(match[1].slice(5))))))
}

function validDesktopAdapter(value, parameters, allowedOrigins) {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value.kind !== 'http'
    || typeof value.auth !== 'object' || value.auth === null || Array.isArray(value.auth)) return false
  if (!Object.keys(value).every(key => ['kind', 'auth', 'requests'].includes(key))
    || !Object.keys(value.auth).every(key => ['kind', 'env'].includes(key))) return false
  if (value.auth.kind !== 'none' && (!['bearer-env', 'cookie-env'].includes(value.auth.kind)
    || typeof value.auth.env !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.auth.env))) return false
  return Array.isArray(value.requests) && value.requests.length > 0 && value.requests.length <= 10
    && value.requests.every((request) => {
      if (typeof request !== 'object' || request === null || Array.isArray(request)
        || typeof request.name !== 'string' || !request.name.trim()
        || !['GET', 'POST'].includes(request.method) || typeof request.url !== 'string') return false
      if (!Object.keys(request).every(key => ['name', 'method', 'url', 'query', 'jsonBody'].includes(key))) return false
      try {
        const url = new URL(request.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || !allowedOrigins.includes(url.origin)) return false
      } catch { return false }
      return (request.query === undefined || validDesktopValues(request.query, parameters))
        && (request.jsonBody === undefined || validDesktopValues(request.jsonBody, parameters))
        && !(request.method === 'GET' && request.jsonBody !== undefined)
    })
}

function validateDraft(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schemaVersion !== 'tandix.agent-skill/v1'
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.goal !== 'string' || !value.goal.trim()
    || typeof value.success !== 'string' || !value.success.trim()
    || !Array.isArray(value.steps) || value.steps.length === 0
    || !value.steps.every((step) => typeof step === 'string' && step.trim())
    || !Array.isArray(value.parameters)
    || !value.parameters.every((input) => typeof input?.name === 'string'
      && /^[a-zA-Z][a-zA-Z0-9]*$/u.test(input.name)
      && typeof input.label === 'string' && input.label.trim()
      && ['string', 'secret', 'number', 'boolean'].includes(input.type)
      && typeof input.required === 'boolean')
    || !Array.isArray(value.allowedOrigins) || !value.allowedOrigins.every(validOrigin)
    || !validStartUrl(value.startUrl, value.allowedOrigins)
    || !validDesktopAdapter(value.desktopAdapter, value.parameters, value.allowedOrigins)
    || !Array.isArray(value.questions) || !value.questions.every((question) => typeof question === 'string')) {
    fail('AI output is not a valid tandix.agent-skill/v1 draft')
  }
  if (value.questions.length > 0) fail(`Clarify before saving: ${value.questions.join('; ')}`)
  return value
}

function validateSkill(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schemaVersion !== 'tandix.agent-skill/v1' || value.version !== 1
    || typeof value.id !== 'string' || !value.id
    || typeof value.sourceSessionId !== 'string' || typeof value.createdAt !== 'number') fail('Invalid Tandix skill JSON')
  validateDraft({ ...value, questions: [] })
  return value
}

function validateTask(value, skill) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schemaVersion !== 'tandix.agent-task/v1'
    || typeof value.id !== 'string' || !value.id
    || value.skillId !== skill.id || value.skillVersion !== skill.version
    || typeof value.inputs !== 'object' || value.inputs === null || Array.isArray(value.inputs)
    || !Object.values(value.inputs).every((input) => ['string', 'number', 'boolean'].includes(typeof input))
    || !['controlled-tab', 'agent-runtime'].includes(value.target?.kind)
    || typeof value.requestedAt !== 'number') fail('Invalid task or mismatched skill')
  if (value.target.origin !== undefined && !validOrigin(value.target.origin)) fail('Invalid target origin')
  if (value.target.origin !== undefined && skill.allowedOrigins.length > 0
    && !skill.allowedOrigins.includes(value.target.origin)) fail('Task target is outside the skill origin policy')
  if (value.target.kind === 'agent-runtime' && skill.desktopAdapter === undefined) {
    fail('This skill has no reviewed command-line adapter and is browser-only')
  }
  for (const parameter of skill.parameters) {
    if (parameter.required && !Object.hasOwn(value.inputs, parameter.name)) fail(`Missing input ${parameter.name}`)
  }
  return value
}

async function run() {
  if (command === 'prompt-extract') {
    const evidencePath = option('--evidence')
    if (!evidencePath) fail('Usage: pnpm skill prompt-extract --evidence redacted-trace.txt [--lang zh|en]')
    const evidence = await readFile(evidencePath, 'utf8')
    if (evidence.length > 500_000) fail('Evidence exceeds 500 KB; select a shorter, redacted segment')
    const instructions = await readFile(new URL('agent-skill-extract.md', promptDir), 'utf8')
    process.stdout.write(`${instructions}\n\nRespond in ${option('--lang') === 'en' ? 'English' : 'Chinese'} inside JSON string fields.\n\n<selected-evidence>\n${evidence}\n</selected-evidence>\n`)
    return
  }
  if (command === 'finalize') {
    const draftPath = option('--draft')
    const outputPath = option('--output')
    if (!draftPath || !outputPath) fail('Usage: pnpm skill finalize --draft ai-output.json --output my-skill.json')
    const draft = validateDraft(parseJson(await readFile(draftPath, 'utf8')))
    const skill = {
      schemaVersion: 'tandix.agent-skill/v1', version: 1, id: randomUUID(),
      name: draft.name, goal: draft.goal, steps: draft.steps, success: draft.success,
      parameters: draft.parameters, allowedOrigins: draft.allowedOrigins,
      ...(draft.startUrl === undefined ? {} : { startUrl: draft.startUrl }),
      ...(draft.desktopAdapter === undefined ? {} : { desktopAdapter: draft.desktopAdapter }),
      sourceSessionId: '', createdAt: Date.now(),
    }
    await writeFile(outputPath, `${JSON.stringify(skill, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(`Saved ${outputPath}\n`)
    return
  }
  if (command === 'prompt-run') {
    const skillPath = option('--skill')
    const taskPath = option('--task')
    if (!skillPath || !taskPath) fail('Usage: pnpm skill prompt-run --skill my-skill.json --task task.json')
    const skill = validateSkill(parseJson(await readFile(skillPath, 'utf8')))
    const task = validateTask(parseJson(await readFile(taskPath, 'utf8')), skill)
    const promptName = task.target.kind === 'agent-runtime' ? 'agent-skill-desktop-run.md' : 'agent-skill-run.md'
    const instructions = await readFile(new URL(promptName, promptDir), 'utf8')
    process.stdout.write(`${instructions}\n\n<skill-json>\n${JSON.stringify(skill, null, 2)}\n</skill-json>\n\n<task-json>\n${JSON.stringify(task, null, 2)}\n</task-json>\n`)
    return
  }
  process.stdout.write(`Tandix skill workflow (repo: ${root})\n\nCommands:\n  prompt-extract --evidence FILE [--lang zh|en]\n  finalize --draft AI_OUTPUT.json --output SKILL.json\n  prompt-run --skill SKILL.json --task TASK.json\n`)
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
