export function DeleteConfirmation({
  text,
  pending,
  error,
  onCancel,
  onConfirm,
  confirmLabel = '삭제',
}: {
  text: string
  pending: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
  confirmLabel?: string
}) {
  return (
    <>
      <p>{text}</p>
      <div className="chat-delete-actions">
        <button
          type="button"
          role="menuitem"
          disabled={pending}
          className="chat-delete-cancel"
          onClick={onCancel}
        >
          취소
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={pending}
          className="chat-delete-confirm"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
