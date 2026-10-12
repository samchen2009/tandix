// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLocale, loadUiLocale, localeFromLanguage, saveUiLocale, UI_LOCALE_STORAGE_KEY } from '../src/i18n.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser locale selection', () => {
  it('uses Chinese for every zh locale variant', () => {
    expect(localeFromLanguage('zh')).toBe('zh')
    expect(localeFromLanguage('zh-CN')).toBe('zh')
    expect(localeFromLanguage('zh-TW')).toBe('zh')
    expect(localeFromLanguage('ZH-hant-HK')).toBe('zh')
  })

  it('defaults unknown or missing locales to Chinese', () => {
    expect(localeFromLanguage('en-US')).toBe('en')
    expect(localeFromLanguage('ja-JP')).toBe('zh')
    expect(localeFromLanguage('fr')).toBe('zh')
    expect(localeFromLanguage(undefined)).toBe('zh')
  })

  it('starts in Chinese and persists an explicit English choice', async () => {
    const records: Record<string, string> = {}
    vi.stubGlobal('chrome', { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: records[key] })),
      set: vi.fn(async (values: Record<string, string>) => { Object.assign(records, values) }),
    } } })
    expect(await loadUiLocale()).toBe('zh')
    expect(getUiLocale()).toBe('zh')
    await saveUiLocale('en')
    expect(records[UI_LOCALE_STORAGE_KEY]).toBe('en')
    expect(await loadUiLocale()).toBe('en')
    await saveUiLocale('zh')
  })

  it('provides localized panel and prompt copy in both languages', () => {
    expect(PANEL_COPY.en.app.newSession).toBe('New chat')
    expect(PANEL_COPY.en.app.overviewPage).toBe('Give me an overview')
    expect(PANEL_COPY.en.approval.allowOnce).toBe('Allow once')
    expect(PANEL_COPY.en.settings.unrestrictedBrowserAccess).toBe('Allow unrestricted browser control')
    expect(PANEL_COPY.en.app.overviewPrompt).toMatch(/^First give me an overview/)
    expect(PANEL_COPY.zh.app.newSession).toBe('新对话')
    expect(PANEL_COPY.zh.app.overviewPage).toBe('先概览这个页面')
    expect(PANEL_COPY.zh.approval.allowOnce).toBe('仅允许这一次')
    expect(PANEL_COPY.zh.settings.unrestrictedBrowserAccess).toBe('允许模型完全控制浏览器')
  })
})
