import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LarkAuth } from '../runtime/lark-auth.mjs'

test('Feishu login requests only Docs access and keeps the device code off the browser response', async () => {
  const calls = []
  const auth = new LarkAuth({ cwd: '/tmp/tandix-test-workspace',
    run: async (args) => {
      calls.push(args)
      if (args.includes('--help')) return { code: 0, stdout: '--command --doc-format', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ verification_url: 'https://open.feishu.cn/auth/example',
        device_code: 'private-device-code', expires_in: 600 }), stderr: '' }
    },
    makeQr: async () => 'data:image/png;base64,AQID',
  })
  const result = await auth.start()
  assert.deepEqual(calls, [
    ['docs', '+update', '--help'],
    ['auth', 'login', '--domain', 'docs', '--no-wait', '--json'],
  ])
  assert.equal(result.authorizationUrl, 'https://open.feishu.cn/auth/example')
  assert.equal(result.qrCodeDataUrl, 'data:image/png;base64,AQID')
  assert.doesNotMatch(JSON.stringify(result), /private-device-code/u)
  assert.equal(auth.pending.deviceCode, 'private-device-code')
})

test('Feishu login rejects untrusted authorization URLs and missing device codes', async () => {
  const auth = new LarkAuth({ cwd: '/tmp', makeQr: async () => null,
    run: async (args) => ({ code: 0,
      stdout: args.includes('--help') ? '--command --doc-format'
        : JSON.stringify({ verification_url: 'https://evil.example/auth', device_code: 'secret' }), stderr: '' }),
  })
  await assert.rejects(auth.start(), /unexpected authorization link/u)
  assert.equal(auth.pending, null)
})

test('Feishu login completes with its in-memory device code and verifies user identity', async () => {
  const calls = []
  const auth = new LarkAuth({ cwd: '/tmp', makeQr: async () => null,
    run: async (args) => {
      calls.push(args)
      if (args.includes('--help')) return { code: 0, stdout: '--command --doc-format', stderr: '' }
      if (args.includes('--no-wait')) return { code: 0, stdout: JSON.stringify({
        verification_url: 'https://open.feishu.cn/auth/example', device_code: 'private-device-code',
      }), stderr: '' }
      if (args.includes('--device-code')) return { code: 0, stdout: '{"ok":true}', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ identities: { user: {
        status: 'ready', tokenStatus: 'valid', userName: 'Test User',
      } } }), stderr: '' }
    },
  })
  await auth.start()
  const result = await auth.complete()
  assert.deepEqual(result, { state: 'connected', userName: 'Test User' })
  assert.deepEqual(calls[2], ['auth', 'login', '--device-code', 'private-device-code'])
  assert.equal(auth.pending, null)
})

test('Feishu status never exposes token or app credentials', async () => {
  const auth = new LarkAuth({ cwd: '/tmp', run: async (args) => ({ code: 0,
    stdout: args.includes('--help') ? '--command --doc-format' : JSON.stringify({
      appSecret: 'private-secret', accessToken: 'private-token', identities: {
      user: { status: 'ready', tokenStatus: 'valid', userName: 'Test User', scope: ['docx:document'] },
    } }), stderr: '' }),
  })
  const result = await auth.status()
  assert.deepEqual(result, { state: 'connected', userName: 'Test User' })
  assert.doesNotMatch(JSON.stringify(result), /private-secret|private-token/u)
})

test('Feishu login refuses an outdated CLI before requesting authorization', async () => {
  const calls = []
  const auth = new LarkAuth({ cwd: '/tmp', run: async (args) => {
    calls.push(args)
    return { code: 0, stdout: '--mode --markdown', stderr: '' }
  } })
  assert.deepEqual(await auth.status(), { state: 'cli-outdated' })
  await assert.rejects(auth.start(), /too old/u)
  assert.deepEqual(calls, [['docs', '+update', '--help'], ['docs', '+update', '--help']])
})
