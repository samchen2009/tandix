#!/usr/bin/env node
/** An Agent uses this CLI to investigate a history; this CLI does not call a model. */
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeHistory, indexHistory, searchHistory, retrieveEvents, validateInference } from './activity-inference.mjs'

const [command, ...args] = process.argv.slice(2)
function option(name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
function required(name) { const value = option(name); if (!value) throw new Error(`Missing ${name}`); return value }
function numberOption(name, fallback) { return option(name) === undefined ? fallback : Number(option(name)) }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

async function load(path) {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('History exceeds the prototype 32 MiB input limit; it was not truncated')
  const source = await readFile(path, 'utf8')
  let input
  try { input = JSON.parse(source) } catch {
    const lines = source.split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line))
    const header = lines[0]?.type === 'recording' ? lines.shift() : {}
    input = { ...header, events: lines.map(line => line.type === 'event' ? { ...line, type: undefined } : line) }
  }
  return normalizeHistory(input)
}

async function run() {
  if (!command || command === 'help') {
    process.stdout.write('Read-only activity investigation (no model call):\n'
      + '  prompt --history FILE\n  index --history FILE [--offset N] [--limit N]\n'
      + '  search --history FILE --query TEXT [--offset N] [--limit N]\n'
      + '  events --history FILE --ids ID,ID\n  validate --history FILE --report FILE\n')
    return
  }
  const historyPath = resolve(required('--history'))
  const history = await load(historyPath)
  const offset = numberOption('--offset', 0), limit = numberOption('--limit', 40)
  switch (command) {
    case 'index': print(indexHistory(history, offset, limit)); break
    case 'search': print(searchHistory(history, required('--query'), offset, limit)); break
    case 'events': print(retrieveEvents(history, required('--ids').split(','))); break
    case 'validate': print(validateInference(history, JSON.parse(await readFile(required('--report'), 'utf8')))); break
    case 'prompt': {
      const prompt = await readFile(new URL('../prompts/activity-inference.md', import.meta.url), 'utf8')
      process.stdout.write(`${prompt}\n\nLocal retrieval tool:\n${JSON.stringify({
        executable: process.execPath, cli: fileURLToPath(import.meta.url), history: historyPath,
        examples: [
          ['index', '--history', historyPath, '--offset', '0', '--limit', '40'],
          ['search', '--history', historyPath, '--query', 'filename or page label'],
          ['events', '--history', historyPath, '--ids', 'event-1,event-2'],
          ['validate', '--history', historyPath, '--report', '/path/to/report.json'],
        ],
      }, null, 2)}\n\nInitial index (page through nextOffset; retrieve truncated entries):\n`)
      print(indexHistory(history, 0, limit))
      break
    }
    default: throw new Error(`Unknown command: ${command}`)
  }
}
run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
