interface ConfirmDialogProps {
  /** Worded by whoever is asking, since only they know what is about to go. */
  message: string;
  /** Names the dialog to a screen reader, e.g. "本の削除". */
  dialogLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before something that cannot be taken back. */
export function ConfirmDialog({
  message,
  dialogLabel,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    // Escape is handled here rather than on document, so the listener lives and
    // dies with the dialog itself.
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={dialogLabel}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
      >
        <p className="text-sm text-gray-800">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 cursor-pointer hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white cursor-pointer hover:bg-red-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
