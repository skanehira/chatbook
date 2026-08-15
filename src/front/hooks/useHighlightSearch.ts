import { useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher } from "../lib/fetcher";
import {
  selectionSearchResultSchema,
  type SelectionSearchResult,
} from "../../shared/schemas/selection";

/** Asks which of a book's highlights hold a query, in the passage or the chat. */
export type SearchSelections = (pdfId: string, query: string) => Promise<SelectionSearchResult>;

const searchKey = (pdfId: string, query: string) =>
  `/api/pdf/${pdfId}/search?q=${encodeURIComponent(query)}`;

export const requestSelectionSearch: SearchSelections = (pdfId, query) =>
  fetcher(searchKey(pdfId, query), selectionSearchResultSchema);

/** Long enough that a word is one search, short enough to feel like typing. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * What the reader is looking for, and which highlights hold it.
 *
 * The search is the server's because the chats are not in the book the list was
 * drawn from — only D1 can look through both at once. What comes back is a set
 * of ids, since the list already holds the highlights themselves.
 */
export function useHighlightSearch(
  pdfId: string | undefined,
  search: SearchSelections = requestSelectionSearch,
  debounceMs: number = SEARCH_DEBOUNCE_MS,
) {
  /** As typed, so the box never lags behind the reader. */
  const [query, setQueryState] = useState("");
  /** What has settled, and is worth a round trip. */
  const [term, setTerm] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounced in the handler rather than in an effect: the timer belongs to the
  // keystroke that started it, and there is no outside state to synchronise.
  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setTerm(next.trim()), debounceMs);
    },
    [debounceMs],
  );

  const searching = pdfId !== undefined && term !== "";
  const { data, error, isLoading } = useSWR(
    searching ? searchKey(pdfId, term) : null,
    () => search(pdfId as string, term),
    // The list keeps showing the last answer while the next one is on its way,
    // rather than falling back to every highlight for a moment.
    { keepPreviousData: true },
  );

  const matchedIds = useMemo(
    () => (searching && data ? new Set(data.selectionIds) : null),
    [searching, data],
  );

  return {
    query,
    setQuery,
    /** The ids that matched, or null while nothing is being searched for. */
    matchedIds,
    isSearching: isLoading,
    searchError: error instanceof Error ? error.message : undefined,
  };
}
