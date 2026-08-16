import { useCallback, useMemo, useState } from "react";
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

/**
 * What the reader is looking for, and which highlights hold it.
 *
 * The search is the server's because the chats are not in the book the list was
 * drawn from — only D1 can look through both at once. What comes back is a set
 * of ids, since the list already holds the highlights themselves.
 *
 * Nothing is asked of the server until `submit`: typing is not searching, and
 * a round trip per keystroke would answer questions the reader is still in the
 * middle of writing — a half-typed Japanese word most of all.
 */
export function useHighlightSearch(
  pdfId: string | undefined,
  search: SearchSelections = requestSelectionSearch,
) {
  /** As typed, which is not yet what is being looked for. */
  const [query, setQuery] = useState("");
  /** What the reader last asked to be searched for. */
  const [term, setTerm] = useState("");

  const submit = useCallback(() => setTerm(query.trim()), [query]);

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
    /** Runs the search for whatever is in the box, clearing it if it is empty. */
    submit,
    /** The ids that matched, or null while nothing is being searched for. */
    matchedIds,
    isSearching: isLoading,
    searchError: error instanceof Error ? error.message : undefined,
  };
}
