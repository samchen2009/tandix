import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { normalizeHistory, indexHistory, searchHistory, retrieveEvents, validateInference } from '../activity-inference.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../tandix-activity.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/activity-long-history.json', import.meta.url))
const event = (id, at = 1) => ({ id, capturedAt: at, kind: 'click', tab: { id: 1, title: 'Example', url: 'https://example.invalid/' }, target: { name: 'Save' } })
function report() {
  return {
    schemaVersion: 'tandix.activity-inference/v1', answer: 'Possibly saved a draft.', reviewedEventIds: ['a', 'b'],
    tasks: [{ id: 'task-1', title: 'Draft', interpretation: 'A hypothesis, not proof.', confidence: 'possible',
      eventIds: ['a', 'b'], counterEvidenceIds: [], segments: [{ summary: 'Clicked save.', eventIds: ['a'] }],
      links: [{ fromEventId: 'a', toEventId: 'b', claim: 'May be a continuation.', basisEventIds: ['a', 'b'], confidence: 'possible', alternatives: ['Another draft could be involved.'] }],
      outcome: { status: 'unknown', description: 'No visible completion.', eventIds: [] }, uncertainties: ['No record identity.'] }],
    unassignedEventIds: [], limitations: ['Typed content is unavailable.'],
  }
}

test('retains 501 events over weeks; pagination and IDs do not create task boundaries', () => {
  const events = Array.from({ length: 501 }, (_, i) => ({ ...event(undefined, 1 + i * 86400000), observation: `item ${i}` })).reverse()
  const history = normalizeHistory(events)
  const ids = []
  for (let offset = 0; offset !== null;) {
    const page = indexHistory(history, offset, 73)
    ids.push(...page.items.map(item => item.id)); offset = page.nextOffset
  }
  assert.equal(ids.length, 501)
  assert.equal(new Set(ids).size, 501)
  assert.equal(ids[0], 'event-501')
  assert.equal(ids.at(-1), 'event-1')
  assert.equal(history.events.at(-1).at, new Date(1 + 500 * 86400000).toISOString())
  assert.equal('tasks' in history, false)
})

test('same-name files are retrieval candidates without inferred associations', async () => {
  const history = normalizeHistory(JSON.parse(await readFile(fixture, 'utf8')))
  const found = searchHistory(history, 'report.csv', 0, 200)
  assert.deepEqual(found.items.map(item => item.id), ['e05', 'e08', 'e09', 'e34', 'e35'])
  assert.equal(found.items.find(item => item.id === 'e35').observation.includes('南区'), true)
  assert.equal('links' in found, false)
  assert.equal(indexHistory(history, 0, 12).nextOffset, 12)
  assert.deepEqual(retrieveEvents(history, ['e35', 'e09']).map(item => item.id), ['e35', 'e09'])
})

test('accepts recording and redacted timeline contracts while removing input and URL credentials', () => {
  const raw = { ...event('a'), selectedLabels: ['private selection'], value: { kind: 'literal', value: 'sensitive input' },
    filename: '/private/user/report.csv', url: 'https://u:password@example.invalid/123456?token=hidden#secret', request: { body: 'private' } }
  const history = normalizeHistory({ summary: { eventCount: 10 }, events: [raw] })
  const json = JSON.stringify(history)
  for (const text of ['sensitive input', 'private selection', 'password', 'token=hidden', '/private/user', 'request']) assert.equal(json.includes(text), false, text)
  assert.equal(history.events[0].facts.filename, 'report.csv')
  assert.equal(history.events[0].facts.url, 'https://example.invalid/:id')
  assert.equal(history.events[0].facts.selectedOptionCount, 1)
  assert.match(history.coverage.limitations.join(' '), /exports only 1/u)
  const timeline = normalizeHistory({ timeline: [{ id: 'b', capturedAtIso: '2026-10-05T00:00:00Z', kind: 'input',
    tab: { id: 2 }, details: { value: { kind: 'literal-redacted', characterCount: 14 } } }] })
  assert.equal(timeline.events[0].facts.value.characterCount, 14)
  const secret = normalizeHistory([{ ...event('c'), value: { kind: 'secret', parameter: 'password', placeholder: 'private' } }])
  assert.deepEqual(secret.events[0].facts.value, { kind: 'secret', redacted: true })
})

test('rejects invalid/duplicate events and oversized observations instead of discarding them', () => {
  assert.throws(() => normalizeHistory([event('a'), event('a')]), /duplicate/u)
  assert.throws(() => normalizeHistory([{ ...event('a'), capturedAt: 1e30 }]), /Invalid time/u)
  assert.throws(() => normalizeHistory([{ ...event('a'), observation: 'x'.repeat(2001) }]), /2000/u)
  const history = normalizeHistory([event('a')])
  assert.throws(() => indexHistory(history, -1), /Offset/u)
  assert.throws(() => indexHistory(history, 0, 201), /limit/u)
  assert.throws(() => searchHistory(history, ' '), /empty/u)
  assert.throws(() => retrieveEvents(history, ['missing']), /Unknown/u)
  const long = normalizeHistory([{ ...event('b'), observation: 'x'.repeat(900) }])
  assert.equal(indexHistory(long).items[0].summaryTruncated, true)
  assert.equal(retrieveEvents(long, ['b'])[0].observation.length, 900)
})

test('validator enforces evidence coverage but explicitly does not certify semantic truth', () => {
  const history = normalizeHistory([event('a'), event('b')])
  const valid = report()
  valid.tasks[0].interpretation = 'Even an implausible claim cannot be semantically checked by this validator.'
  const result = validateInference(history, valid)
  assert.equal(result.valid, true)
  assert.equal(result.semanticCorrectnessChecked, false)
  assert.equal(result.unreviewedEventCount, 0)
  for (const [mutate, expected] of [
    [r => r.tasks[0].eventIds.push('missing'), /unknown event/u],
    [r => r.reviewedEventIds.pop(), /not declared reviewed/u],
    [r => r.unassignedEventIds.push('a'), /both assigned/u],
    [r => r.tasks[0].links[0].alternatives = [], /alternatives/u],
    [r => r.tasks[0].outcome.status = 'observed', /Outcome evidence/u],
    [r => r.limitations = [], /capture gaps/u],
  ]) {
    const changed = report(); mutate(changed)
    assert.throws(() => validateInference(history, changed), expected)
  }
  const extra = normalizeHistory([event('a'), event('b'), event('c')])
  assert.equal(validateInference(extra, report()).unreviewedEventCount, 1)
  const outside = report(); outside.tasks[0].segments[0].eventIds = ['c']
  assert.throws(() => validateInference(extra, outside), /outside this task/u)
})

test('CLI reads browser JSONL, exposes paginated tools and validates failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tandix-activity-'))
  try {
    const path = join(root, 'history.jsonl')
    await writeFile(path, [JSON.stringify({ type: 'recording', summary: { eventCount: 2 } }),
      ...[event('a'), event('b')].map(e => JSON.stringify({ type: 'event', ...e }))].join('\n'))
    const { stdout } = await exec(process.execPath, [cli, 'index', '--history', path, '--limit', '1'])
    assert.equal(JSON.parse(stdout).nextOffset, 1)
    const prompt = await exec(process.execPath, [cli, 'prompt', '--history', path, '--limit', '1'])
    assert.match(prompt.stdout, /NOT task boundaries/u)
    assert.match(prompt.stdout, /Local retrieval tool/u)
    assert.match(prompt.stdout, /"nextOffset": 1/u)
    const reportPath = join(root, 'report.json')
    await writeFile(reportPath, JSON.stringify(report()))
    const checked = await exec(process.execPath, [cli, 'validate', '--history', path, '--report', reportPath])
    assert.equal(JSON.parse(checked.stdout).semanticCorrectnessChecked, false)
    await assert.rejects(exec(process.execPath, [cli, 'events', '--history', path, '--ids', 'missing']), /Unknown event ID/u)
    assert.equal((await readFile(path, 'utf8')).split('\n').length, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
