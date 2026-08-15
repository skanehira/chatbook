import { useState } from "react";
import type { ActiveSelection } from "../../atoms/chatAtom";
import { filterHighlights, parsePageBound } from "../../lib/highlightFilter";

export interface HighlightListItem {
  id: string;
  selectedText: string;
  pageNumber: number;
  color: string;
  createdAt: string;
}

interface HighlightListPanelProps {
  highlights: HighlightListItem[];
  onSelect: (selection: ActiveSelection) => void;
}

/** Newest first, so the passage the reader just marked is at the top. */
function newestFirst(highlights: HighlightListItem[]): HighlightListItem[] {
  return highlights.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const NARROWING_INPUT_CLASS =
  "rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none";

export function HighlightListPanel({ highlights, onSelect }: HighlightListPanelProps) {
  // What the reader typed, kept as typed: the bounds are read back out of the
  // boxes on every render rather than stored a second time.
  const [query, setQuery] = useState("");
  const [pageFromInput, setPageFromInput] = useState("");
  const [pageToInput, setPageToInput] = useState("");

  if (highlights.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <div className="text-center">
          <p className="text-gray-500 text-sm font-medium mb-1">チャットを開始するには</p>
          <p className="text-gray-400 text-sm">PDF内のテキストを選択して質問してください</p>
        </div>
      </div>
    );
  }

  const filter = {
    query,
    pageFrom: parsePageBound(pageFromInput),
    pageTo: parsePageBound(pageToInput),
  };
  const narrowing =
    filter.query.trim() !== "" || filter.pageFrom !== null || filter.pageTo !== null;
  const narrowed = filterHighlights(highlights, filter);

  return (
    <div className="flex flex-col h-full bg-white">
      <h2 className="px-4 py-3 border-b border-gray-200 text-sm font-medium text-gray-600 shrink-0">
        {narrowing
          ? `ハイライト ${highlights.length}件中 ${narrowed.length}件`
          : `ハイライト ${highlights.length}件`}
      </h2>
      {/* One row, so the list still has room to read in a sheet drawn half way up. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-4 py-2">
        <input
          type="search"
          aria-label="ハイライトを検索"
          placeholder="本文を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`min-w-0 flex-1 ${NARROWING_INPUT_CLASS}`}
        />
        <input
          inputMode="numeric"
          aria-label="開始ページ"
          placeholder="開始"
          value={pageFromInput}
          onChange={(e) => setPageFromInput(e.target.value)}
          className={`w-14 ${NARROWING_INPUT_CLASS}`}
        />
        <span aria-hidden="true" className="text-xs text-gray-400">
          〜
        </span>
        <input
          inputMode="numeric"
          aria-label="終了ページ"
          placeholder="終了"
          value={pageToInput}
          onChange={(e) => setPageToInput(e.target.value)}
          className={`w-14 ${NARROWING_INPUT_CLASS}`}
        />
      </div>
      {narrowed.length === 0 ? (
        <p className="flex-1 px-4 py-6 text-center text-sm text-gray-400">
          一致するハイライトがありません
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {newestFirst(narrowed).map((highlight) => (
            <li key={highlight.id}>
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    id: highlight.id,
                    selectedText: highlight.selectedText,
                    pageNumber: highlight.pageNumber,
                  })
                }
                className="flex w-full cursor-pointer items-start gap-3 border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50"
              >
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: highlight.color }}
                  className="mt-1 h-3 w-3 shrink-0 rounded-full"
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-sm text-gray-700">
                    {highlight.selectedText}
                  </span>
                  <span className="mt-1 block text-xs text-gray-400">{`${highlight.pageNumber}ページ`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
