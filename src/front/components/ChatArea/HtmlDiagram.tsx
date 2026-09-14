// oxlint-disable-next-line no-restricted-imports -- document への keydown 購読 (Escape で図解を閉じる) に必要
import { useState, useEffect } from "react";
import { asStandaloneDocument } from "../../lib/htmlDiagram";

/** What the link says when the fence named its diagram nothing. */
const DEFAULT_CAPTION = "図解を見る";

interface HtmlDiagramProps {
  /** The fence's contents: the document the popup renders. */
  html: string;
  /** The caption the fence wrote in its info string, or null when it wrote none. */
  caption: string | null;
}

/**
 * A ```html fence, shown as the link that opens it.
 *
 * The answer is written by a model and the reader is one person, but the fence
 * is still text out of a document: it is rendered in a frame of its own rather
 * than laid into the page, so nothing it carries can read the session it is
 * being read in.
 */
export function HtmlDiagram({ html, caption }: HtmlDiagramProps) {
  const [open, setOpen] = useState(false);
  const label = caption ?? DEFAULT_CAPTION;

  return (
    <div className="mb-2 last:mb-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer text-blue-600 underline"
      >
        {label}
      </button>
      {open && <DiagramPopup html={html} label={label} onClose={() => setOpen(false)} />}
    </div>
  );
}

interface DiagramPopupProps {
  html: string;
  /** Names the popup, the frame inside it, and the button that closes it. */
  label: string;
  onClose: () => void;
}

function DiagramPopup({ html, label, onClose }: DiagramPopupProps) {
  // Escape is read off the document rather than off this panel, the way
  // ConfirmDialog reads it off itself: a click on the header leaves focus on
  // the body, which no wrapper's onKeyDown ever sees. (A click inside the frame
  // is out of reach either way — keys in a sandboxed document never reach its
  // parent — so the close button is the way out that always works.)
  //
  // The same listener stops what it does not use. The viewer reads the
  // page-turn keys from `window`, one step further out than this, so a figure
  // open over the page does not turn the page underneath it while the reader
  // is looking at something else.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      e.stopPropagation();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex h-[80dvh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 pl-4">
          <h2 className="truncate text-sm font-semibold text-gray-800">{label}</h2>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="図解を閉じる"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center text-xl text-gray-500 hover:text-gray-800"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        {/* allow-scripts without allow-same-origin: the frame draws itself
            under an opaque origin, with no path back to the app's cookies,
            storage or DOM */}
        <iframe
          title={label}
          srcDoc={asStandaloneDocument(html)}
          sandbox="allow-scripts"
          className="h-full w-full flex-1 bg-white"
        />
      </div>
    </div>
  );
}
