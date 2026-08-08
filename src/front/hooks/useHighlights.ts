import { useCallback, useMemo } from "react";
import { useBook, fetchBook, type LoadBook } from "./useBook";
import type { CreatedSelection, SelectionHighlight } from "../../shared/schemas/selection";

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

/** The highlights of the book currently open, and a way to add one. */
export function useHighlights(pdfId: string | undefined, loadBook: LoadBook = fetchBook) {
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

  return { highlights, addHighlight };
}
