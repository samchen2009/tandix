// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it('retries an unresponsive handshake before reporting a connection failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const client = new BridgeClient({ onError, onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} })
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0]!.open()
    await vi.advanceTimersByTimeAsync(5001)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('30 seconds'))
    client.stop()
  })

  it('reports malformed WebSocket addresses without an unhandled rejection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('invalid WebSocket URL') } })
    const onError = vi.fn()
    const client = new BridgeClient({ onError, onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} })
    client.start('not-a-url', '')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.state).toBe('stopped')
    expect(onError).toHaveBeenCalledWith('invalid WebSocket URL')
  })

  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('allows a slow startup to recover without showing a transient error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let ready = false
    const onError = vi.fn()
    const client = new BridgeClient({ onError, onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} }, async () => ready)
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(18_000)
    expect(onError).not.toHaveBeenCalled()
    ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.state).toBe('connected')
    expect(onError).not.toHaveBeenCalled()
    client.stop()
  })

  it('reports a sustained outage once and cancels old errors when switched or stopped', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn()
    const client = new BridgeClient({ onError, onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} }, async () => false)
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(onError).not.toHaveBeenCalled()
    client.start('ws://127.0.0.1:3081/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onError).toHaveBeenCalledOnce()
    client.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('ignores late handshake frames from the previous connection generation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onError = vi.fn(); const onHelloOk = vi.fn()
    const client = new BridgeClient({ onError, onHelloOk, onStateChange: () => {}, onFrame: () => {} })
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const old = FakeWebSocket.instances[0]!
    old.open()
    await vi.advanceTimersByTimeAsync(0)
    client.start('ws://127.0.0.1:3081/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    old.receive({ t: 'error', message: 'stale failure' })
    old.receive({ t: 'hello.ok', caps: {} })
    expect(onError).not.toHaveBeenCalled()
    expect(onHelloOk).not.toHaveBeenCalled()
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
