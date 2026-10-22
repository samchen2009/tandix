import { useRef, useState, type ReactNode } from 'react'
import type { PanelCopy } from './strings.ts'

/** Keep edits separate from the composer and retain them if sending fails. */
export function EditableUserMessage({ text, hasAttachments, disabled, copy, onResend, children }: {
  text: string
  hasAttachments: boolean
  disabled: boolean
  copy: PanelCopy
  onResend: (text: string) => Promise<boolean>
  children: ReactNode
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editedText, setEditedText] = useState(text)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const editButtonRef = useRef<HTMLButtonElement>(null)

  function cancel(): void {
    if (submittingRef.current) return
    setEditing(false)
    requestAnimationFrame(() => editButtonRef.current?.focus())
  }

  async function resend(): Promise<void> {
    if (disabled || submittingRef.current || (editedText.trim() === '' && !hasAttachments)) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (await onResend(editedText)) setEditing(false)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return <div className={`user-message${editing ? ' is-editing' : ''}`}>
    {editing ? <form className="message-editor" onSubmit={(event) => { event.preventDefault(); void resend() }}>
      <span className="message-editor-label">{copy.app.editMessage}</span>
      <textarea autoFocus value={editedText} aria-label={copy.app.editMessage} rows={3}
        disabled={submitting}
        onChange={(event) => setEditedText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') { event.preventDefault(); cancel() }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void resend() }
        }} />
      <p className="message-editor-hint">{hasAttachments ? copy.app.editAttachmentsHint : copy.app.editResendHelp}</p>
      <div className="message-editor-actions">
        <button type="button" disabled={submitting} onClick={cancel}>{copy.app.cancelEdit}</button>
        <button type="submit" className="primary" disabled={disabled || submitting || (editedText.trim() === '' && !hasAttachments)}>
          {submitting ? copy.app.resendingMessage : copy.app.resendMessage}
        </button>
      </div>
    </form> : <>
      {children}
      <div className="message-actions">
        <button type="button" ref={editButtonRef} className="message-edit-button" disabled={disabled}
          aria-label={copy.app.editMessage} title={copy.app.editMessage}
          onClick={() => { setEditedText(text); setEditing(true) }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15Z" /></svg>
        </button>
      </div>
    </>}
  </div>
}
