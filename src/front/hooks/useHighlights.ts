import { useCallback, useMemo } from "react";
import type { ResultAsync } from "neverthrow";
import { useBook, fetchBook, type LoadBook } from "./useBook";
import { resultFetcher, type ApiError } from "../lib/fetcher";
import {
  selectionDeletedSchema,
  type CreatedSelection,
  type SelectionHighlight,
} from "../../shared/schemas/selection";

/** Books saved before highlights carried a colour fall back to the palette. */
const HIGHLIGHT_COLORS = [
  "#FFEB3B",
  "#FF9800",
  "#4CAF50",
  "#2196F3",
  "#9C27B0",
  "#F44336",
  "#00BCD4",
  "#FF5722",
];

const NO_HIGHLIGHTS: SelectionHighlight[] = [];

/** Removes a highlight. A write, so its failure comes back in the value. */
export type DeleteHighlight = (
  pdfId: string,
  selectionId: string,
) => ResultAsync<unknown, ApiError>;

const requestHighlightDeletion: DeleteHighlight = (pdfId, selectionId) =>
  resultFetcher(`/api/pdf/${pdfId}/selections/${selectionId}`, selectionDeletedSchema, {
    method: "DELETE",
  });

/** The highlights of the book currently open, and ways to add and remove one. */
export function useHighlights(
  pdfId: string | undefined,
  loadBook: LoadBook = fetchBook,
  deleteHighlight: DeleteHighlight = requestHighlightDeletion,
) {
  const { data, mutate } = useBook(pdfId, loadBook);

  const highlights = useMemo(
    () =>
      data?.selections.map((selection, i) => ({
        ...selection,
        color: selection.color || HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
      })) ?? NO_HIGHLIGHTS,
    [data],
  );

  /**
   * Show a highlight the moment it is made. The server has just stored it, so
   * re-reading the book would only confirm what was sent; the colour is left
   * for the palette to fill in by position, as it is for every other highlight.
   */
  const addHighlight = useCallback(
    (selection: CreatedSelection) => {
      void mutate(
        (book) =>
          book ? { ...book, selections: [...book.selections, { ...selection, color: "" }] } : book,
        { revalidate: false },
      );
    },
    [mutate],
  );

  /**
   * Drop a highlight the reader asked to be rid of, along with its chat.
   *
   * Only once the server has taken it: a list that lost it optimistically would
   * have to put it back on a refusal, and the reader would watch it return.
   *
   * The book is named by the caller rather than taken from the one being read,
   * because there is no highlight to delete until a book is in hand — asking
   * for it here is what keeps this from having to answer for a book that is
   * not open yet. **It has to be the book this hook was given**: the request
   * follows `bookId` but the list that loses the highlight is the one under
   * `pdfId`, and naming two different books would take it off the wrong one.
   */
  const removeHighlight = useCallback(
    (bookId: string, selectionId: string): ResultAsync<void, ApiError> =>
      deleteHighlight(bookId, selectionId).map(() => {
        void mutate(
          (book) =>
            book
              ? { ...book, selections: book.selections.filter((s) => s.id !== selectionId) }
              : book,
          { revalidate: false },
        );
      }),
    [deleteHighlight, mutate],
  );

  return { highlights, addHighlight, removeHighlight };
}
