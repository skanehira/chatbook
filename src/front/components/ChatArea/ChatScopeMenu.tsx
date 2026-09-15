// oxlint-disable-next-line no-restricted-imports -- document への keydown / mousedown 購読 (Escape と外側クリックで閉じる) に必要
import { useState, useRef, useEffect } from "react";
import { chapterLabel, pageRangeLabel, scopeLabel, type ScopeChapter } from "../../lib/chatScope";

interface ChatScopeMenuProps {
  /** The chapters the book offers; empty for a book whose outline is not known. */
  chapters: ScopeChapter[];
  /** The pages the whole book runs to, for the row that asks about all of it. */
  pageCount: number;
  /** The chapters the next question is aimed at. Empty is the whole book. */
  scope: ScopeChapter[];
  onChange: (scope: ScopeChapter[]) => void;
}

/**
 * Which part of the book the next question is aimed at.
 *
 * Per question rather than per conversation: a reader who has just had the
 * book summarised then asks about one chapter without leaving the thread, and
 * a thread divided by scope would hide half of what they asked.
 *
 * Opened from the header of the book's own conversation, where it has to share
 * one row with the way back to the list — hence a chip that counts the rest
 * rather than naming every chapter picked.
 */
export function ChatScopeMenu({ chapters, pageCount, scope, onChange }: ChatScopeMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  // A chapter is named by the page it starts on, which no two spans share.
  const isPicked = (chapter: ScopeChapter) =>
    scope.some((picked) => picked.startPage === chapter.startPage);

  const toggle = (chapter: ScopeChapter, on: boolean) => {
    onChange(
      on
        ? // Earliest first, so the chip names the chapter the reader would say
          // they are asking about rather than the last one they checked.
          [...scope, chapter].sort((one, other) => one.startPage - other.startPage)
        : scope.filter((picked) => picked.startPage !== chapter.startPage),
    );
  };

  return (
    <div ref={menuRef} className="relative ml-auto">
      <button
        type="button"
        aria-label={`範囲: ${scopeLabel(scope)}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[11rem] cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
      >
        {/* The name gives way first: it is the arrow that says there is a menu
            under this, and a long chapter title must not take it away. */}
        <span className="min-w-0 truncate">範囲: {scopeLabel(scope)}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        // Capped so it fits a sheet drawn half way up a phone: the header it
        // hangs off is one row there, and the list scrolls under it.
        <div className="absolute right-0 top-full z-50 mt-1 max-h-60 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-xl">
          <button
            type="button"
            aria-pressed={scope.length === 0}
            onClick={() => {
              onChange([]);
              // The whole book is a finished choice, unlike a chapter, which is
              // usually one of several being gathered.
              setOpen(false);
            }}
            className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
              scope.length === 0 ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">本全体</span>
            <span className="shrink-0 text-xs text-gray-500">
              {pageRangeLabel({ startPage: 1, endPage: pageCount })}
            </span>
          </button>

          {chapters.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-gray-500">この本には目次がありません</p>
          ) : (
            chapters.map((chapter) => (
              <label
                key={chapter.startPage}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={isPicked(chapter)}
                  onChange={(e) => toggle(chapter, e.target.checked)}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{chapterLabel(chapter)}</span>
                <span className="shrink-0 text-xs text-gray-500">{pageRangeLabel(chapter)}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
