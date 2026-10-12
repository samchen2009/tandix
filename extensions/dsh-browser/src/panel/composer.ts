/** Atomic composer draft helpers for rejected prompt restoration. */

export interface ComposerDraft<Image, File = never> {
  text: string
  images: Image[]
  files: File[]
}

export function emptyComposerDraft<Image, File = never>(): ComposerDraft<Image, File> {
  return { text: '', images: [], files: [] }
}

/** A picker result cannot mutate the composer during another image read or prompt admission. */
export function canAcceptImageSelection(addingImages: boolean, sendingPrompt: boolean): boolean {
  return !addingImages && !sendingPrompt
}

/** Restore both submitted parts together, or preserve a newer draft unchanged. */
export function restoreSubmittedDraft<Image, File>(
  current: ComposerDraft<Image, File>,
  submitted: ComposerDraft<Image, File>,
): ComposerDraft<Image, File> {
  return current.text === '' && current.images.length === 0 && current.files.length === 0 ? submitted : current
}
