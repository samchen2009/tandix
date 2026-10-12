// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { DomRecorder } from '../src/content/recorder.ts'

describe('DOM recorder privacy boundary', () => {
  it('redacts a password before the event leaves the content script', () => {
    const emit = vi.fn()
    const recorder = new DomRecorder(emit)
    const input = document.createElement('input')
    input.id = 'login-password'
    input.name = 'password'
    input.type = 'password'
    input.value = 'never-store-this'
    document.body.append(input)

    const captureInput = (recorder as unknown as {
      onInput: (event: Pick<Event, 'isTrusted' | 'composedPath'>) => void
    }).onInput
    captureInput({ isTrusted: true, composedPath: () => [input, document.body, document] })

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'input',
      value: { kind: 'secret', parameter: 'password', placeholder: '{{secret}}' },
    }))
    expect(JSON.stringify(emit.mock.calls)).not.toContain('never-store-this')
  })

  it('records a select as a semantic select event', () => {
    const emit = vi.fn()
    const recorder = new DomRecorder(emit)
    const select = document.createElement('select')
    select.name = 'country'
    select.innerHTML = '<option value="cn" selected>China</option>'
    document.body.append(select)
    const captureChange = (recorder as unknown as {
      onChange: (event: Pick<Event, 'isTrusted' | 'composedPath'>) => void
    }).onChange

    captureChange({ isTrusted: true, composedPath: () => [select, document.body, document] })

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'select',
      value: { kind: 'literal', value: 'cn' },
      selectedLabels: ['China'],
    }))
  })
})
