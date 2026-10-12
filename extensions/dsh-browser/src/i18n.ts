/** Languages supported by the extension UI. Chinese is the first-run default. */
export type UiLocale = 'en' | 'zh'

export const UI_LOCALE_STORAGE_KEY = 'traceforge.uiLocale'
let currentLocale: UiLocale = 'zh'

/** Normalize an explicit language choice; unknown values fall back to Chinese. */
export function localeFromLanguage(language: string | null | undefined): UiLocale {
  const normalized = language?.trim().toLowerCase() ?? ''
  return normalized === 'en' || normalized.startsWith('en-') ? 'en' : 'zh'
}

/** Return the current in-process choice without waiting on extension storage. */
export function getUiLocale(): UiLocale {
  return currentLocale
}

/** Load an explicit choice, if any. Browser language never overrides Chinese by default. */
export async function loadUiLocale(): Promise<UiLocale> {
  if (typeof chrome === 'undefined' || typeof chrome.storage?.local?.get !== 'function') return currentLocale
  try {
    const stored = (await chrome.storage.local.get(UI_LOCALE_STORAGE_KEY))[UI_LOCALE_STORAGE_KEY]
    currentLocale = stored === 'en' ? 'en' : 'zh'
  } catch {
    currentLocale = 'zh'
  }
  return currentLocale
}

/** Persist the user's language selection for future side panels. */
export async function saveUiLocale(locale: UiLocale): Promise<void> {
  currentLocale = locale
  if (typeof chrome !== 'undefined' && typeof chrome.storage?.local?.set === 'function') {
    await chrome.storage.local.set({ [UI_LOCALE_STORAGE_KEY]: locale })
  }
}
