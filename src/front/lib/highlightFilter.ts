/** What the reader has narrowed the highlight list down to. */
export interface HighlightFilter {
  /** Typed as-is; the spaces a reader leaves around it are not part of it. */
  query: string;
  /** The first page to keep, or null for no lower bound. */
  pageFrom: number | null;
  /** The last page to keep, or null for no upper bound. */
  pageTo: number | null;
}

/**
 * The highlights the reader is looking for, in the order they were given.
 *
 * Typed against the shape rather than the list item, so the passage and the
 * page are all this has to know about a highlight.
 */
export function filterHighlights<T extends { selectedText: string; pageNumber: number }>(
  highlights: T[],
  { query, pageFrom, pageTo }: HighlightFilter,
): T[] {
  const needle = query.trim().toLowerCase();

  return highlights.filter(
    (highlight) =>
      (needle === "" || highlight.selectedText.toLowerCase().includes(needle)) &&
      (pageFrom === null || highlight.pageNumber >= pageFrom) &&
      (pageTo === null || highlight.pageNumber <= pageTo),
  );
}

/**
 * The page a reader typed into one end of the range, or null for no bound.
 *
 * Anything that is not a page of a book — an empty box, a word, a fraction, a
 * number below the first page — leaves that end of the range open rather than
 * emptying the list while the reader is still typing.
 */
export function parsePageBound(input: string): number | null {
  // Digits and nothing else: `Number` would also take "0x10" and "1e3", which
  // are ways of writing a number rather than ways of writing a page. The
  // full-width ones a Japanese IME produces are folded in first — they name the
  // same page, and turning the IME off to type a page number is not something
  // to ask of a reader in the middle of a Japanese book.
  const trimmed = halfWidthDigits(input.trim());
  if (!/^\d+$/.test(trimmed)) return null;

  const page = Number(trimmed);
  return page >= 1 ? page : null;
}

function halfWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}
