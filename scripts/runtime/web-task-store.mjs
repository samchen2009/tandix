/** Durable webpage jobs. A transport disconnect never submits or cancels a turn. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const MAX_TEXT = 1_000_000
const MAX_EVENTS = 500
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, path) } finally { rmSync(temporary, { force: true }) }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

export class WebTaskStore {
  constructor({ directory, backend = 'codex', agentId = backend, createSession, adoptSession, inspectSession, startTurn, cancelSession }) {
    Object.assign(this, { directory, backend, agentId, createSession, adoptSession, inspectSession, startTurn, cancelSession })
    this.instance = randomUUID(); this.jobs = new Map(); this.operations = new Map(); this.timers = new Map(); this.deltas = new Map(); this.closed = false
  }
  path(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('invalid-request', 'Invalid task ID'); return join(this.directory, id) }
  read(id, origin) {
    if (this.closed) fail('agent-error', 'Task runtime stopped; reconnect to the original task')
    const cached = this.jobs.get(id)
    let job = cached
    if (!job) {
      try { job = JSON.parse(readFileSync(join(this.path(id), 'task.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') fail('unknown-task', 'Task not found'); throw error }
    }
    if (job.origin !== origin || job.backend !== this.backend) fail('unknown-task', 'Task not found')
    if (job.agentId !== this.agentId) fail('agent-mismatch', 'Task belongs to a different agent profile. Restore the original profile before resuming.')
    if (job.owner === this.instance) this.jobs.set(id, job)
    return job
  }
  save(job) { job.updatedAt = Date.now(); atomic(join(this.path(job.taskId), 'task.json'), job) }
  claim(job) {
    const path = join(this.path(job.taskId), 'owner.json')
    const lock = join(this.path(job.taskId), '.claim-lock')
    try { mkdirSync(lock, { mode: 0o700 }) }
    catch (error) { if (error.code === 'EEXIST') fail('task-busy', 'Task ownership is being recovered; retry the same task ID'); throw error }
    try {
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, 'utf8'))
        if (owner.instance === this.instance) return
        if (alive(owner.pid)) fail('task-busy', 'Another companion owns this task')
        rmSync(path)
      }
      writeFileSync(path, JSON.stringify({ pid: process.pid, instance: this.instance }), { mode: 0o600, flag: 'wx' })
    } finally { rmSync(lock, { recursive: true }) }
  }
  event(job, type, details = {}) {
    const event = { taskId: job.taskId, seq: ++job.seq, type, ...details }
    job.events.push(event)
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS)
    this.save(job)
    return event
  }
  view(job, afterSeq = 0) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > job.seq) fail('invalid-cursor', 'Invalid event cursor')
    const events = job.events.filter(event => event.seq > afterSeq)
    // Bound RPC replies even when the final answer or many text deltas are large.
    const page = []; let size = 0
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (page.length && size + bytes > 512 * 1024) break
      page.push(event); size += bytes
    }
    return { taskId: job.taskId, backend: job.backend, agentId: job.agentId, sessionId: job.sessionId ?? null,
      status: job.status, attempt: job.attempt, turnId: job.turnId ?? null,
      createdAt: job.createdAt, updatedAt: job.updatedAt, lastSeq: job.seq,
      cursor: page.at(-1)?.seq ?? afterSeq, hasMore: page.length < events.length,
      reset: afterSeq < (job.events[0]?.seq ?? 1) - 1, text: job.progressText || job.text,
      events: page, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
      resumable: job.status === 'interrupted' && !!job.sessionId }
  }
  async run({ taskId, origin, prompt, files = [], responseFormat = 'text', timeoutMs = 600_000 }) {
    if (this.closed) fail('agent-error', 'Task runtime stopped; reconnect to the original task')
    this.path(taskId)
    let parsed
    try { parsed = new URL(origin) } catch { fail('invalid-request', 'Invalid task origin') }
    if (parsed.origin !== origin || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) fail('invalid-request', 'Invalid task origin')
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 64_000 || !['text', 'json'].includes(responseFormat)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000 || !Array.isArray(files) || files.length > 10) fail('invalid-request', 'Invalid task')
    let total = 0
    for (const file of files) {
      if (typeof file.name !== 'string' || !file.name || file.name.length > 160 || /[\x00-\x1f/\\]/u.test(file.name)
        || !['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mediaType)
        || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.data)) fail('invalid-file', 'Invalid attachment')
      total += Buffer.from(file.data, 'base64').length
    }
    if (total > 25 * 1024 * 1024) fail('invalid-file', 'Attachment limit exceeded')
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, files, responseFormat, timeoutMs })).digest('hex')
    if (existsSync(this.path(taskId))) {
      if (!existsSync(join(this.path(taskId), 'task.json'))) fail('task-busy', 'Task acceptance is in progress. Query this ID.')
      const previous = this.read(taskId, origin)
      if (previous.fingerprint !== fingerprint) fail('task-conflict', 'This task ID already has different input. Attach to the original task.')
      return this.view(previous)
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    // Exclusive directory creation prevents two companion processes from accepting the same ID.
    try { mkdirSync(this.path(taskId), { mode: 0o700 }) }
    catch (error) { if (error.code === 'EEXIST') fail('task-busy', 'Task acceptance is in progress. Query this ID.'); throw error }
    const inputs = files.map((file, index) => {
      const path = join(this.path(taskId), `input-${index}`)
      writeFileSync(path, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' })
      return { name: file.name, mediaType: file.mediaType, path }
    })
    const job = { version: 2, taskId, origin, backend: this.backend, agentId: this.agentId, fingerprint, prompt, files: inputs,
      responseFormat, timeoutMs, deadline: Date.now() + timeoutMs, createdAt: Date.now(), updatedAt: Date.now(),
      owner: this.instance, ownerPid: process.pid, status: 'accepted', attempt: 1, seq: 0, events: [], text: '', resumeRequests: {} }
    this.jobs.set(taskId, job)
    this.claim(job)
    this.event(job, 'accepted')
    this.arm(job)
    this.launch(job, false)
    return this.view(job)
  }
  launch(job, resume, prompt) {
    const operation = this.execute(job, resume, prompt).finally(() => { this.operations.delete(job.taskId) })
    this.operations.set(job.taskId, operation)
    void operation.catch(error => { process.stderr.write(`Tandix task persistence failed: ${error.message}\n`) })
  }
  async execute(job, resume, prompt) {
    try {
      if (!resume) {
        job.status = 'creating'; this.event(job, 'creating')
        const { sessionId } = await this.createSession(job)
        if (this.closed) return
        if (typeof sessionId !== 'string' || !sessionId) fail('session-unavailable', 'Agent did not return the original session ID')
        job.sessionId = sessionId
        if (TERMINAL.has(job.status) || job.status === 'interrupted') {
          this.event(job, 'mapped', { backend: job.backend, sessionId }); await this.cancelSession(job); return
        }
        // The mapping is durable BEFORE the first model prompt is sent.
        job.status = 'ready'; this.event(job, 'mapped', { backend: job.backend, sessionId })
      }
      if (TERMINAL.has(job.status)) { await this.cancelSession(job); return }
      await this.adoptSession(job)
      if (this.closed) return
      if (TERMINAL.has(job.status) || job.status === 'interrupted') { if (job.sessionId) await this.cancelSession(job); return }
      job.status = 'dispatching'; this.event(job, resume ? 'resuming' : 'starting')
      const input = resume ? [{ type: 'text', text: prompt || 'Continue the original task from its existing context and files. Inspect prior progress and outputs first. Preserve completed work; do not restart or repeat completed grading. Report any uncertainty about interrupted actions.' }]
        : [{ type: 'text', text: job.prompt + (job.responseFormat === 'json' ? '\nReturn the final answer as valid JSON, without Markdown fences.' : '') },
          ...job.files.map(file => ({ type: file.mediaType === 'application/pdf' ? 'file' : 'image', name: file.name,
            mediaType: file.mediaType, data: readFileSync(file.path).toString('base64') }))]
      const result = await this.startTurn(job, input)
      if (this.closed) return
      if (result?.turn?.id) job.turnId = result.turn.id
      if (TERMINAL.has(job.status)) { this.save(job); if (job.status !== 'completed') await this.cancelSession(job); return }
      // A synchronous completion notification may arrive before the RPC response.
      if (job.status === 'dispatching') { job.status = 'running'; this.event(job, 'started') }
      this.arm(job)
    } catch (error) {
      if (!this.closed && !TERMINAL.has(job.status)) this.interrupt(job, error.message)
    }
  }
  arm(job) {
    clearTimeout(this.timers.get(job.taskId))
    if (TERMINAL.has(job.status) || job.status === 'interrupted') return
    const timer = setTimeout(() => { void this.cancel(job.origin, job.taskId, 'timeout').catch(error => {
      process.stderr.write(`Tandix task timeout could not be recorded: ${error.message}\n`)
    }) }, Math.max(1, job.deadline - Date.now()))
    timer.unref?.(); this.timers.set(job.taskId, timer)
  }
  interrupt(job, message) {
    clearTimeout(this.timers.get(job.taskId)); this.flushDelta(job)
    job.status = 'interrupted'; job.error = { code: 'interrupted', message }
    this.event(job, 'interrupted', { error: job.error })
  }
  async get(origin, taskId, afterSeq = 0) {
    const job = this.read(taskId, origin)
    if (!TERMINAL.has(job.status) && job.owner !== this.instance && !alive(job.ownerPid)) {
      this.claim(job)
      // Reading can reconcile history; it NEVER creates a session or submits a prompt.
      job.owner = this.instance; job.ownerPid = process.pid; this.jobs.set(taskId, job)
      if (job.sessionId) {
        await this.adoptSession(job)
        try {
          const turn = await this.inspectSession(job)
          if (this.closed) fail('agent-error', 'Task runtime stopped; reconnect to the original task')
          if (!job.awaitingInput && turn && turn.id !== job.priorTurnId && turn.status === 'completed') {
            job.turnId = turn.id; this.complete(job, turn.text)
          }
          else this.interrupt(job, job.error?.message ?? 'Companion restarted. Original session and files are retained; explicit resume is required.')
        } catch (error) { if (this.closed) throw error; this.interrupt(job, `Could not reconcile original session: ${error.message}`) }
      } else this.interrupt(job, 'Session creation was interrupted before its ID was recorded. No new session was created automatically.')
    }
    return this.view(job, afterSeq)
  }
  async resume({ origin, taskId, requestId, prompt }) {
    if (typeof requestId !== 'string' || !UUID.test(requestId) || (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 64_000))) fail('invalid-request', 'Invalid resume request')
    await this.get(origin, taskId)
    const job = this.read(taskId, origin)
    const digest = createHash('sha256').update(prompt ?? '').digest('hex')
    if (job.resumeRequests[requestId]) {
      if (job.resumeRequests[requestId].digest !== digest) fail('task-conflict', 'Resume request ID has different input')
      return this.view(job)
    }
    if (TERMINAL.has(job.status)) return this.view(job)
    if (job.owner !== this.instance || this.operations.has(taskId) || job.status !== 'interrupted') fail('task-busy', 'The original task is still running; attach instead')
    if (!job.sessionId) fail('session-unavailable', 'The original session ID is unavailable; automatic resubmission is unsafe')
    // Recheck durable history before any continuation, including lost completion responses.
    const turn = await this.inspectSession(job)
    if (this.closed) fail('agent-error', 'Task runtime stopped; reconnect to the original task')
    if (job.resumeRequests[requestId]) {
      if (job.resumeRequests[requestId].digest !== digest) fail('task-conflict', 'Resume request ID has different input')
      return this.view(job)
    }
    if (this.operations.has(taskId) || job.status !== 'interrupted') fail('task-busy', 'The original task is still running; attach instead')
    if (!job.awaitingInput && turn && turn.id !== job.priorTurnId && turn.status === 'completed') {
      job.turnId = turn.id; this.complete(job, turn.text); return this.view(job)
    }
    if (turn?.status === 'inProgress') fail('task-busy', 'The original agent turn is still in progress')
    job.priorTurnId = turn?.id ?? job.turnId ?? null
    job.turnId = null
    job.resumeRequests[requestId] = { attempt: ++job.attempt, digest }
    job.owner = this.instance; job.ownerPid = process.pid; job.deadline = Date.now() + job.timeoutMs
    delete job.error; delete job.awaitingInput; job.text = ''; job.status = 'ready'; this.save(job)
    this.launch(job, true, prompt)
    return this.view(job)
  }
  async cancel(origin, taskId, reason = 'cancelled') {
    const job = this.read(taskId, origin)
    if (TERMINAL.has(job.status)) return this.view(job)
    if (job.owner !== this.instance && alive(job.ownerPid)) fail('task-busy', 'Another companion owns this active task')
    this.jobs.set(taskId, job); this.adoptSession(job)
    clearTimeout(this.timers.get(taskId)); this.flushDelta(job)
    job.status = reason === 'timeout' ? 'interrupted' : 'cancelled'; job.error = { code: reason, message: reason === 'timeout' ? 'Task timed out. The original context is retained for explicit continuation.' : 'Cancelled by caller' }
    this.event(job, job.status, { error: job.error })
    if (job.sessionId) await this.cancelSession(job)
    return this.view(job)
  }
  complete(job, text) {
    this.flushDelta(job); clearTimeout(this.timers.get(job.taskId))
    try {
      if (typeof text !== 'string' || !text.trim()) fail('empty-result', 'Agent returned no final text')
      if (text.length > MAX_TEXT) fail('result-too-large', 'Agent result exceeds the limit')
      job.text = text; job.result = { taskId: job.taskId, text,
        ...(job.responseFormat === 'json' ? { data: JSON.parse(text) } : {}) }
      job.status = 'completed'; delete job.error
      job.progressText = text
      this.event(job, 'completed', { result: job.result })
    } catch (error) {
      job.status = 'failed'; job.error = { code: error.code ?? 'invalid-json', message: error.message }
      this.event(job, 'failed', { error: job.error })
    }
  }
  flushDelta(job) {
    const pending = this.deltas.get(job.taskId)
    if (!pending) return
    clearTimeout(pending.timer); this.deltas.delete(job.taskId)
    job.progressText = ((job.progressText ?? '') + pending.text).slice(-MAX_TEXT)
    this.event(job, 'delta', { text: pending.text })
  }
  ingest(frame) {
    if (frame.t !== 'event') return
    const payload = frame.frame?.payload
    const job = [...this.jobs.values()].find(job => job.sessionId === payload?.sessionId)
    if (!job || TERMINAL.has(job.status)) return
    if (frame.frame.method === 'session/assistant-stream' && payload.frame?.chunk?.type === 'text-delta') {
      const text = payload.frame.chunk.text
      if (typeof text !== 'string') return
      const pending = this.deltas.get(job.taskId)
      if (pending) pending.text = (pending.text + text).slice(-MAX_TEXT)
      else {
        const timer = setTimeout(() => this.flushDelta(job), 250); timer.unref?.()
        this.deltas.set(job.taskId, { text: text.slice(-MAX_TEXT), timer })
      }
    } else if (frame.frame.method === 'agent-approval/requested') this.event(job, 'waiting-for-user')
    else if (frame.frame.method === 'question/requested') {
      const questions = (payload.questions ?? []).filter(question => question.secret !== true && typeof question.question === 'string')
        .slice(0, 4).map(question => question.question.slice(0, 500)).join('\n')
      job.awaitingInput = true
      this.interrupt(job, `Agent needs clarification. Resume this task with the additional information.${questions ? `\n${questions}` : ''}`)
      void this.cancelSession(job).catch(() => {})
    } else if (frame.frame.method === 'session/event') {
      const event = payload.event; const data = event?.data ?? {}
      if (event?.type === 'turn/start' && typeof data.turnId === 'string') {
        job.turnId = data.turnId; this.save(job)
      } else if (event?.type === 'assistant/message') {
        job.text = (data.message?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('').slice(0, MAX_TEXT + 1)
        this.save(job)
      } else if (event?.type === 'turn/end') {
        if (job.awaitingInput || job.status === 'interrupted' && data.status !== 'completed') return
        if (data.status === 'completed') this.complete(job, job.text)
        else this.interrupt(job, typeof data.error === 'string' ? data.error : 'Agent turn was interrupted')
      }
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const job of this.jobs.values()) {
      if (!TERMINAL.has(job.status) && job.status !== 'interrupted') this.interrupt(job, 'Companion stopped; resume the original session after reconnecting.')
      job.owner = null; job.ownerPid = null; this.save(job)
      const lock = join(this.path(job.taskId), 'owner.json')
      try {
        if (JSON.parse(readFileSync(lock, 'utf8')).instance === this.instance) rmSync(lock)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const timer of this.timers.values()) clearTimeout(timer)
  }
}
