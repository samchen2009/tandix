import type { ChatSkill } from './chat-skill.ts'

const encoder = new TextEncoder()

function directoryName(skill: ChatSkill): string {
  const fromName = skill.name.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '')
  const suffix = skill.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8)
  return fromName ? `${fromName}-${suffix || 'export'}` : `tandix-skill-${suffix || 'export'}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** A dependency-free HTTP runner emitted only for a reviewed desktop adapter. */
export function renderDesktopRunScript(): string {
  return [
    "#!/usr/bin/env node",
    "import { readFile } from 'node:fs/promises'",
    '',
    "const skill = JSON.parse(await readFile(new URL('../references/tandix-skill.json', import.meta.url), 'utf8'))",
    "if (skill.desktopAdapter?.kind !== 'http') throw new Error('This skill has no reviewed command-line HTTP adapter')",
    "const fileIndex = process.argv.indexOf('--input-file')",
    "const raw = fileIndex >= 0 && process.argv[fileIndex + 1]",
    "  ? await readFile(process.argv[fileIndex + 1], 'utf8')",
    "  : await new Promise((resolve, reject) => {",
    "      let text = ''",
    "      process.stdin.setEncoding('utf8')",
    "      process.stdin.on('data', (chunk) => { text += chunk })",
    "      process.stdin.on('end', () => resolve(text))",
    "      process.stdin.on('error', reject)",
    "    })",
    '',
    "const inputs = raw.trim() === '' ? {} : JSON.parse(raw)",
    "if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) throw new Error('Inputs must be a JSON object')",
    "const declared = new Map(skill.parameters.map((parameter) => [parameter.name, parameter]))",
    "for (const name of Object.keys(inputs)) if (!declared.has(name)) throw new Error(`Unknown input: ${name}`)",
    "for (const parameter of skill.parameters) {",
    "  if (!Object.hasOwn(inputs, parameter.name) && parameter.defaultValue !== undefined) inputs[parameter.name] = parameter.defaultValue",
    "  if (parameter.required && !Object.hasOwn(inputs, parameter.name)) throw new Error(`Missing required input: ${parameter.name}`)",
    "  if (!Object.hasOwn(inputs, parameter.name)) continue",
    "  const value = inputs[parameter.name]",
    "  const expected = parameter.type === 'number' ? 'number' : parameter.type === 'boolean' ? 'boolean' : 'string'",
    "  if (typeof value !== expected) throw new Error(`Input ${parameter.name} must be ${expected}`)",
    "}",
    '',
    "function timeValue(name) {",
    "  const now = new Date()",
    "  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0)",
    "  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)",
    "  const value = name.startsWith('yesterday-start') ? yesterdayStart : name.startsWith('today-end') ? todayEnd : null",
    "  if (value === null) throw new Error(`Unsupported time token: ${name}`)",
    "  if (name.endsWith('-iso')) return value.toISOString()",
    "  if (name.endsWith('-ms')) return value.getTime()",
    "  if (name.endsWith('-s')) return Math.floor(value.getTime() / 1000)",
    "  throw new Error(`Unsupported time token: ${name}`)",
    "}",
    "function tokenValue(name) {",
    "  if (name.startsWith('time:')) return timeValue(name.slice(5))",
    "  if (!Object.hasOwn(inputs, name)) throw new Error(`Missing input: ${name}`)",
    "  return inputs[name]",
    "}",
    "function resolveValue(value) {",
    "  if (typeof value !== 'string') return value",
    "  const exact = /^\\{\\{([^{}]+)\\}\\}$/.exec(value)",
    "  if (exact) return tokenValue(exact[1])",
    "  return value.replace(/\\{\\{([^{}]+)\\}\\}/g, (_match, name) => String(tokenValue(name)))",
    "}",
    "function valueAtPath(value, path) {",
    "  if (path === '$') return value",
    "  return path.split('.').reduce((current, key) => current !== null && typeof current === 'object' ? current[key] : undefined, value)",
    "}",
    "const auth = skill.desktopAdapter.auth",
    "const authValue = auth.kind === 'none' ? null : process.env[auth.env]",
    "if (auth.kind !== 'none' && !authValue) throw new Error(`Missing authentication environment variable: ${auth.env}`)",
    "const results = []",
    "for (const request of skill.desktopAdapter.requests) {",
    "  const url = new URL(request.url)",
    "  for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, String(resolveValue(value)))",
    "  const headers = { accept: 'application/json' }",
    "  if (auth.kind === 'bearer-env') headers.authorization = `Bearer ${authValue}`",
    "  if (auth.kind === 'cookie-env') headers.cookie = authValue",
    "  const init = { method: request.method, headers, redirect: 'error' }",
    "  if (request.jsonBody !== undefined) {",
    "    headers['content-type'] = 'application/json'",
    "    init.body = JSON.stringify(Object.fromEntries(Object.entries(request.jsonBody).map(([name, value]) => [name, resolveValue(value)])))",
    "  }",
    "  const response = await fetch(url, init)",
    "  const text = await response.text()",
    "  let data",
    "  try { data = text === '' ? null : JSON.parse(text) } catch { data = text }",
    "  if (!response.ok) throw new Error(`${request.name} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)",
    "  let itemCount",
    "  if (request.response?.listPath !== undefined) {",
    "    const list = valueAtPath(data, request.response.listPath)",
    "    if (!Array.isArray(list)) throw new Error(`${request.name} response did not contain an array at ${request.response.listPath}`)",
    "    itemCount = list.length",
    "  }",
    "  results.push({ name: request.name, status: response.status, ...(itemCount === undefined ? {} : { itemCount }), data })",
    "}",
    "process.stdout.write(`${JSON.stringify({ skillId: skill.id, executedAt: new Date().toISOString(), results }, null, 2)}\\n`)",
    '',
  ].join('\n')
}

export function renderExecutionModesReference(skill: ChatSkill): string {
  const entry = skill.startUrl === undefined ? 'No reusable start URL was captured.' : `Reviewed start URL: ${skill.startUrl}`
  return `# Execution modes

The browser trace was demonstration evidence for the intended outcome. It is not a deterministic replay and does not authorize reusing historical selectors, cookies, tokens, or private request data.

## Tandix browser mode

Run the original Tandix JSON against the currently controlled page. Resolve controls from the live page and retain normal browser approvals.

## Command-line mode

${skill.desktopAdapter === undefined
    ? 'No reviewed command-line adapter is present. This package is browser-only and must not be presented as a desktop automation skill. Add an official API/CLI specification and regenerate the skill.'
    : 'Run `node scripts/run.mjs` with a JSON input object on stdin or pass `--input-file PATH`. The generated runner executes only the reviewed HTTP request specification in `references/tandix-skill.json`; authentication is read from its declared environment variable.'}

Do not infer or call undocumented private endpoints merely because a network URL appeared in the demonstration. If the service exposes only a web UI, this package cannot turn it into a browser-free API.

${entry}

Keep credentials outside the skill package. Pass run-time inputs only for the current invocation and preserve the confirmation boundary for external side effects.
`
}

/** Render a portable Agent skill; runtime values are never part of this file. */
export function renderSkillMarkdown(skill: ChatSkill, slug = directoryName(skill)): string {
  const description = oneLine(skill.goal).slice(0, 240)
  const parameters = skill.parameters.length === 0
    ? 'No required inputs.\n'
    : skill.parameters.map((parameter) =>
      `- \`{{${parameter.name}}}\`: ${oneLine(parameter.label)} (${parameter.type}${parameter.required ? ', required' : ', optional'}${parameter.defaultValue === undefined ? '' : `, default: ${JSON.stringify(parameter.defaultValue)}`}).`,
    ).join('\n') + '\n'
  const origins = skill.allowedOrigins.length === 0
    ? 'Use only the user-approved target unless the user explicitly authorizes another system.'
    : `The browser demonstration used these origins: ${skill.allowedOrigins.join(', ')}. They are scope evidence, not credentials or blanket authorization.`
  const entry = skill.startUrl === undefined ? ''
    : ` If no matching page is open, start from ${skill.startUrl}.`
  const execution = skill.desktopAdapter === undefined
    ? `## Execution mode

This is a **browser-only skill** because no reviewed command-line adapter was available. Run \`references/tandix-skill.json\` with Tandix against the controlled tab. Do not claim that this package can execute without a browser. To add command-line execution, provide an official API/CLI example and regenerate the skill.
`
    : `## Command-line execution

This skill includes a reviewed HTTP adapter and does not require Tandix for command-line runs. Provide inputs as a JSON object on stdin or in a file:

\`\`\`sh
node scripts/run.mjs --input-file inputs.json
\`\`\`

Authentication is read from the environment variable declared in \`references/tandix-skill.json\`; never put credentials in \`inputs.json\`. Tandix browser execution remains available through the same reference JSON.
`

  return `---
name: ${slug}
description: ${JSON.stringify(description)}
---

# ${oneLine(skill.name)}

## Goal

${skill.goal.trim()}

## Inputs

${parameters}
Ask for missing required inputs at run time. Do not store entered values or secrets in this skill.

## Workflow

${skill.steps.map((step, index) => `${index + 1}. ${oneLine(step)}`).join('\n')}

${execution}

Read [references/execution-modes.md](references/execution-modes.md) for the evidence and authorization boundary. A recorded browser workflow does not prove that a supported API or CLI exists.

## Success condition

${skill.success.trim() || 'Verify the observed outcome and report any incomplete steps.'}

## Execution boundaries

Resolve targets from the live environment; historical element indices and selectors are not reusable. ${origins}${entry}
Do not store run-time values or credentials in this skill. Browser permission does not grant filesystem, API, shell, or account permission, and the reverse is also true. Preserve confirmations for external side effects. Report failures and unverified outcomes rather than claiming success.

The original Tandix skill JSON is in [references/tandix-skill.json](references/tandix-skill.json) for re-import; read it only when Tandix metadata is needed.
`
}

interface ZipEntry {
  path: Uint8Array
  data: Uint8Array
  crc: number
  offset: number
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function write16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true) }
function write32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value, true) }

/** Small, dependency-free ZIP writer using the standard stored-file method. */
function zipFiles(files: Array<{ path: string; content: string }>): Uint8Array {
  const entries: ZipEntry[] = []
  const chunks: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const path = encoder.encode(file.path)
    const data = encoder.encode(file.content)
    const crc = crc32(data)
    const header = new Uint8Array(30 + path.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x04034b50)
    write16(view, 4, 20)
    write16(view, 6, 0x0800) // UTF-8 filenames
    write32(view, 14, crc)
    write32(view, 18, data.length)
    write32(view, 22, data.length)
    write16(view, 26, path.length)
    header.set(path, 30)
    entries.push({ path, data, crc, offset })
    chunks.push(header, data)
    offset += header.length + data.length
  }
  const centralOffset = offset
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.path.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x02014b50)
    write16(view, 4, 20)
    write16(view, 6, 20)
    write16(view, 8, 0x0800)
    write32(view, 16, entry.crc)
    write32(view, 20, entry.data.length)
    write32(view, 24, entry.data.length)
    write16(view, 28, entry.path.length)
    write32(view, 42, entry.offset)
    header.set(entry.path, 46)
    chunks.push(header)
    offset += header.length
  }
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, 0x06054b50)
  write16(endView, 8, entries.length)
  write16(endView, 10, entries.length)
  write32(endView, 12, offset - centralOffset)
  write32(endView, 16, centralOffset)
  chunks.push(end)
  offset += end.length
  const result = new Uint8Array(offset)
  let cursor = 0
  for (const chunk of chunks) {
    result.set(chunk, cursor)
    cursor += chunk.length
  }
  return result
}

export function createSkillArchive(skill: ChatSkill): { filename: string; bytes: Uint8Array } {
  const slug = directoryName(skill)
  const files = [
    { path: `${slug}/SKILL.md`, content: renderSkillMarkdown(skill, slug) },
    { path: `${slug}/references/tandix-skill.json`, content: `${JSON.stringify(skill, null, 2)}\n` },
    { path: `${slug}/references/execution-modes.md`, content: renderExecutionModesReference(skill) },
  ]
  if (skill.desktopAdapter !== undefined) {
    files.push({ path: `${slug}/scripts/run.mjs`, content: renderDesktopRunScript() })
  }
  return {
    filename: `${slug}.zip`,
    bytes: zipFiles(files),
  }
}
