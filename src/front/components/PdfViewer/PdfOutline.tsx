import type { OutlineEntry } from "../../hooks/usePdfOutline";

interface PdfOutlineProps {
  outline: OutlineEntry[] | null;
  /** Why the bookmarks could not be read, if they could not. */
  error: string | null;
  currentPage: number;
  onJump: (pageNumber: number) => void;
}

/**
 * The entry a reader is currently inside: the last one that starts at or
 * before the current page.
 */
function findActiveTitle(outline: OutlineEntry[], currentPage: number): string | null {
  let active: OutlineEntry | null = null;
  const walk = (entries: OutlineEntry[]) => {
    for (const entry of entries) {
      if (entry.pageNumber !== null && entry.pageNumber <= currentPage) {
        if (!active || entry.pageNumber >= active.pageNumber!) active = entry;
      }
      walk(entry.children);
    }
  };
  walk(outline);
  return active ? (active as OutlineEntry).title : null;
}

function OutlineItem({
  entry,
  depth,
  activeTitle,
  onJump,
}: {
  entry: OutlineEntry;
  depth: number;
  activeTitle: string | null;
  onJump: (pageNumber: number) => void;
}) {
  const isActive = entry.title === activeTitle;

  return (
    <li>
      <button
        type="button"
        disabled={entry.pageNumber === null}
        onClick={() => entry.pageNumber !== null && onJump(entry.pageNumber)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className={`flex w-full items-baseline gap-2 py-1.5 pr-2 text-left text-xs transition-colors disabled:cursor-default disabled:opacity-40 ${
          isActive
            ? "bg-blue-50 font-medium text-blue-700"
            : "text-gray-700 hover:bg-gray-100 cursor-pointer"
        }`}
      >
        <span className="min-w-0 flex-1 break-words">{entry.title}</span>
        {entry.pageNumber !== null && (
          <span className="shrink-0 text-[10px] text-gray-400">{entry.pageNumber}</span>
        )}
      </button>
      {entry.children.length > 0 && (
        <ul>
          {entry.children.map((child, i) => (
            <OutlineItem
              key={`${child.title}-${i}`}
              entry={child}
              depth={depth + 1}
              activeTitle={activeTitle}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PdfOutline({ outline, error, currentPage, onJump }: PdfOutlineProps) {
  const activeTitle = outline ? findActiveTitle(outline, currentPage) : null;

  return (
    <nav
      aria-label="目次"
      className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white"
    >
      <h2 className="border-b border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500">
        目次
      </h2>

      {error !== null && (
        <p role="alert" className="p-3 text-xs text-red-600">
          目次を読み込めませんでした: {error}
        </p>
      )}

      {outline === null && error === null && (
        <p className="p-3 text-xs text-gray-400">読み込み中...</p>
      )}

      {outline?.length === 0 && (
        <p className="p-3 text-xs text-gray-400">この本には目次がありません</p>
      )}

      {outline && outline.length > 0 && (
        <ul className="flex-1 overflow-y-auto py-1">
          {outline.map((entry, i) => (
            <OutlineItem
              key={`${entry.title}-${i}`}
              entry={entry}
              depth={0}
              activeTitle={activeTitle}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
