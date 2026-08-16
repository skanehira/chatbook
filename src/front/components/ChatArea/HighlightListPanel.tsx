import { useState } from "react";
import type { ResultAsync } from "neverthrow";
import type { ActiveSelection } from "../../atoms/chatAtom";
import type { ApiError } from "../../lib/fetcher";
import { isSubmitKey } from "../../lib/isSubmitKey";
import { ConfirmDialog } from "../ConfirmDialog";

export interface HighlightListItem {
  id: string;
  selectedText: string;
  pageNumber: number;
  color: string;
  createdAt: string;
}

interface HighlightListPanelProps {
  /** The highlights to show: what the search left, when one is running. */
  highlights: HighlightListItem[];
  /** How many the book has in all, so the header can say what was narrowed. */
  total: number;
  /** The search box, held by whoever runs the search. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Runs the search for what is in the box. Typing alone does not. */
  onSearch: () => void;
  /** Whether a search has been run, as opposed to merely typed into the box. */
  searched: boolean;
  /** Why the search itself did not happen, if it did not. */
  searchError?: string;
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

const SEARCH_INPUT_CLASS =
  "rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none";

export function HighlightListPanel({
  highlights,
  total,
  query,
  onQueryChange,
  onSearch,
  searched,
  searchError,
  onSelect,
  onDelete,
}: HighlightListPanelProps) {
  const [pendingDeletion, setPendingDeletion] = useState<HighlightListItem | null>(null);
  /** Why the last deletion did not happen, worded here for the reader. */
  const [actionError, setActionError] = useState<string | null>(null);

  const removeHighlight = async (highlight: HighlightListItem) => {
    setActionError(null);
    setPendingDeletion(null);

    const removal = await onDelete(highlight.id);
    if (removal.isErr()) {
      // Lost if the reader opened a chat while this was in flight, since the
      // list is unmounted by then and there is no list to say it on. What is
      // still true either way is that the highlight is where it was: the
      // reader comes back to it and can ask again.
      setActionError(`削除に失敗しました: ${removal.error.message}`);
    }
  };

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <div className="text-center">
          <p className="text-gray-500 text-sm font-medium mb-1">チャットを開始するには</p>
          <p className="text-gray-400 text-sm">PDF内のテキストを選択して質問してください</p>
        </div>
      </div>
    );
  }

  const failure = actionError ?? (searchError ? `検索に失敗しました: ${searchError}` : null);

  return (
    <div className="flex flex-col h-full bg-white">
      <h2 className="px-4 py-3 border-b border-gray-200 text-sm font-medium text-gray-600 shrink-0">
        {searched ? `ハイライト ${total}件中 ${highlights.length}件` : `ハイライト ${total}件`}
      </h2>
      {/* One row, so the list still has room to read in a sheet drawn half way up. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-4 py-2">
        <input
          type="search"
          aria-label="ハイライトを検索"
          placeholder="ハイライトと会話を検索"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          // Enter runs it too, but not the Enter that confirms a Japanese
          // word: that one belongs to the IME, and searching there would run
          // on half a phrase.
          onKeyDown={(e) => {
            if (isSubmitKey(e.nativeEvent as unknown as KeyboardEvent)) {
              e.preventDefault();
              onSearch();
            }
          }}
          className={`min-w-0 flex-1 ${SEARCH_INPUT_CLASS}`}
        />
        <button
          type="button"
          onClick={onSearch}
          className="shrink-0 cursor-pointer rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
        >
          検索
        </button>
      </div>
      {failure !== null && (
        <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
          {failure}
        </p>
      )}
      {highlights.length === 0 ? (
        <p className="flex-1 px-4 py-6 text-center text-sm text-gray-400">
          一致するハイライトがありません
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {newestFirst(highlights).map((highlight) => (
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
                // 44px square, the size a thumb can hit: the same list is what
                // a phone gets, inside the sheet.
                className="absolute right-1 top-1 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-gray-400 hover:bg-red-50 hover:text-red-600"
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
