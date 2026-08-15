import { useState } from "react";
import type { ResultAsync } from "neverthrow";
import type { ActiveSelection } from "../../atoms/chatAtom";
import type { ApiError } from "../../lib/fetcher";
import { filterHighlights, parsePageBound } from "../../lib/highlightFilter";
import { ConfirmDialog } from "../ConfirmDialog";

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
  /** Removes a highlight and its chat; its failure comes back in the value. */
  onDelete: (selectionId: string) => ResultAsync<void, ApiError>;
}

/** Enough of a passage to tell one delete button from another. */
function shortened(passage: string): string {
  return passage.length <= 20 ? passage : `${passage.slice(0, 20)}…`;
}

/** Newest first, so the passage the reader just marked is at the top. */
function newestFirst(highlights: HighlightListItem[]): HighlightListItem[] {
  return highlights.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const NARROWING_INPUT_CLASS =
  "rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none";

export function HighlightListPanel({ highlights, onSelect, onDelete }: HighlightListPanelProps) {
  // What the reader typed, kept as typed: the bounds are read back out of the
  // boxes on every render rather than stored a second time.
  const [query, setQuery] = useState("");
  const [pageFromInput, setPageFromInput] = useState("");
  const [pageToInput, setPageToInput] = useState("");
  const [pendingDeletion, setPendingDeletion] = useState<HighlightListItem | null>(null);
  /** Why the last deletion did not happen, worded here for the reader. */
  const [actionError, setActionError] = useState<string | null>(null);

  const removeHighlight = async (highlight: HighlightListItem) => {
    setActionError(null);
    setPendingDeletion(null);

    const removal = await onDelete(highlight.id);
    if (removal.isErr()) {
      setActionError(`削除に失敗しました: ${removal.error.message}`);
    }
  };

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
      {actionError !== null && (
        <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
          {actionError}
        </p>
      )}
      {narrowed.length === 0 ? (
        <p className="flex-1 px-4 py-6 text-center text-sm text-gray-400">
          一致するハイライトがありません
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {newestFirst(narrowed).map((highlight) => (
            // The delete button sits beside the row's button rather than
            // inside it: a button within a button is not markup a browser can
            // make sense of.
            <li key={highlight.id} className="relative">
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    id: highlight.id,
                    selectedText: highlight.selectedText,
                    pageNumber: highlight.pageNumber,
                  })
                }
                className="flex w-full cursor-pointer items-start gap-3 border-b border-gray-100 py-3 pl-4 pr-12 text-left hover:bg-gray-50"
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
              <button
                type="button"
                aria-label={`「${shortened(highlight.selectedText)}」を削除`}
                onClick={() => setPendingDeletion(highlight)}
                className="absolute right-2 top-2 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="h-4 w-4"
                >
                  <path d="M6 6l8 8M14 6l-8 8" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDeletion && (
        <ConfirmDialog
          message="このハイライトを削除しますか？このハイライトのチャット履歴も削除されます。"
          dialogLabel="ハイライトの削除"
          confirmLabel="削除する"
          onConfirm={() => removeHighlight(pendingDeletion)}
          onCancel={() => setPendingDeletion(null)}
        />
      )}
    </div>
  );
}
