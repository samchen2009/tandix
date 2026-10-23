// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionTabs } from '../src/panel/SessionTabs.tsx'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'

it('shows all conversation pages, highlights the visible tab, and selects by stable ID', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSelect = vi.fn()
  const state: TabAffinityState = {
    revision: 1, status: 'following', pinned: false,
    controlled: { tabId: 2, windowId: 1, title: 'Details', url: 'https://example.com/details' },
    active: { tabId: 1, windowId: 1, title: 'List', url: 'https://example.com/list' },
    visibleTabId: 2,
    tabs: [
      { tabId: 1, windowId: 1, title: 'List', url: 'https://example.com/list' },
      { tabId: 2, windowId: 1, title: 'Details', url: 'https://example.com/details' },
    ],
  }
  try {
    await act(async () => root.render(createElement(SessionTabs, { state, locale: 'zh', onSelect })))
    const buttons = container.querySelectorAll('button')
    expect([...buttons].map(button => button.textContent)).toEqual(['List', 'Details'])
    expect(buttons[1]?.getAttribute('aria-current')).toBe('page')
    expect(buttons[0]?.hasAttribute('aria-current')).toBe(false)
    await act(async () => buttons[0]!.click())
    expect(onSelect).toHaveBeenCalledWith(1)
    await act(async () => root.render(createElement(SessionTabs, {
      state: { ...state, visibleTabId: 1 }, locale: 'zh', onSelect,
    })))
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page')
    expect(buttons[1]?.hasAttribute('aria-current')).toBe(false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
