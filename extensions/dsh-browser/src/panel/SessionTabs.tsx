import { useEffect, useRef } from 'react'
import type { AffinityTab, TabAffinityState } from '../background/tab-affinity.ts'

function pageLabel(tab: AffinityTab, fallback: string): string {
  if (tab.title.trim() !== '') return tab.title
  try { return new URL(tab.url).hostname || fallback } catch { return fallback }
}

/** The conversation stays mounted while its browser pages are selected. */
export function SessionTabs({ state, locale, onSelect }: {
  state: TabAffinityState | null
  locale: string
  onSelect: (tabId: number) => void
}): React.JSX.Element {
  const activeButton = useRef<HTMLButtonElement>(null)
  const tabs = state?.tabs?.length ? state.tabs : state?.controlled ? [state.controlled] : []
  const activeId = state?.visibleTabId ?? state?.active?.tabId
  const fallback = locale === 'zh' ? '当前网页' : 'Current page'
  useEffect(() => {
    activeButton.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  return <nav className="session-tabs" aria-label={locale === 'zh' ? '会话网页' : 'Conversation pages'}>
    {tabs.length === 0 ? <span className="page-context-placeholder">{fallback}</span> : tabs.map(tab => {
      const active = tab.tabId === activeId
      const label = pageLabel(tab, fallback)
      return <button type="button" key={tab.tabId}
        ref={active ? activeButton : undefined}
        className={`page-context-chip${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={`${label}\n${tab.url}`}
        onClick={() => onSelect(tab.tabId)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></svg>
        <span>{label}</span>
      </button>
    })}
  </nav>
}
