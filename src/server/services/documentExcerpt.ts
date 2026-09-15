import { bookOutlineSchema, type BookOutline } from "../../shared/schemas/book";

/** A run of consecutive pages, as the reader counts them. */
export interface PageRange {
  startPage: number;
  endPage: number;
}

/**
 * The slice of the book a chat sends instead of the whole text. `text` is
 * always verbatim page runs out of `fullText` (pages joined with the same \f
 * they were stored with, in the order the ranges are listed), so a passage the
 * model quotes from one run is guaranteed to be found again by
 * findPageNumber's whole-text scan.
 */
export interface DocumentExcerpt {
  text: string;
  /**
   * The pages the text covers, in the order they were cut: one run for a
   * chapter or a page window, several when a reader asks about chapters that
   * do not touch.
   */
  ranges: PageRange[];
  totalPages: number;
  isPartial: boolean;
}

/**
 * The pages an excerpt covers, as the prompt names them to the model: `5-8`, or
 * `5-8, 35-40` when the reader picked chapters with pages in between. Only ever
 * a label — the text is what the model reads — so a gap between the numbers is
 * a fact about the excerpt rather than something to be papered over.
 */
export function describePages(ranges: PageRange[]): string {
  return ranges.map(({ startPage, endPage }) => `${startPage}-${endPage}`).join(", ");
}

/**
 * Cut the pages a reader asked about out of the book, in the order they run.
 *
 * Ranges are pulled back inside the book and dropped when nothing of them is
 * left in it; ranges that touch or overlap are run together, which is what
 * makes a reader picking two chapters in a row get one verbatim slice rather
 * than two that meet at a seam. Asking about nothing that is in the book falls
 * back to the whole of it: a book whose stored page count disagrees with its
 * own page breaks should not leave the reader a question they cannot ask.
 */
export function selectRanges(fullText: string, requested: PageRange[]): DocumentExcerpt {
  const pages = fullText.split(PAGE_DELIMITER);
  const totalPages = pages.length;
  if (totalPages <= 1) {
    return {
      text: fullText,
      ranges: [{ startPage: 1, endPage: totalPages }],
      totalPages,
      isPartial: false,
    };
  }

  const clipped = requested
    .map(({ startPage, endPage }) => ({
      startPage: Math.max(1, startPage),
      endPage: Math.min(totalPages, endPage),
    }))
    // A range entirely before the book or entirely past it collapses to an
    // empty one rather than being pulled onto the nearest page: the reader
    // asked about pages that are not there.
    .filter(({ startPage, endPage }) => startPage <= endPage)
    .sort((one, other) => one.startPage - other.startPage);

  const ranges = clipped.reduce<PageRange[]>((runs, range) => {
    const last = runs[runs.length - 1];
    // A range that starts where the one before it ends, or inside it, is part
    // of the same run.
    if (last === undefined || range.startPage > last.endPage + 1) return [...runs, { ...range }];

    return [
      ...runs.slice(0, -1),
      { startPage: last.startPage, endPage: Math.max(last.endPage, range.endPage) },
    ];
  }, []);

  const whole = ranges.length === 0 ? [{ startPage: 1, endPage: totalPages }] : ranges;

  return {
    text: whole
      .map(({ startPage, endPage }) => pages.slice(startPage - 1, endPage).join(PAGE_DELIMITER))
      .join(PAGE_DELIMITER),
    ranges: whole,
    totalPages,
    isPartial: !(whole.length === 1 && whole[0].startPage === 1 && whole[0].endPage === totalPages),
  };
}

/**
 * Pages taken on each side of the highlight when the book has no usable
 * outline. 10 makes a 21-page excerpt — about one chapter of a typical
 * 200-page, 10-to-15-chapter technical book, which is the unit the chapter
 * path sends when it can.
 */
export const FALLBACK_WINDOW_PAGES = 10;

const PAGE_DELIMITER = "\f";

/**
 * Read the stored outline column. NULL, broken JSON and JSON of the wrong
 * shape all mean the same thing downstream — no chapter bounds, use the page
 * window — so none of them is worth failing the chat over (the same stance
 * readPositionData takes on a broken highlight row).
 */
export function readStoredOutline(stored: string | null): BookOutline | null {
  if (stored === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const outline = bookOutlineSchema.safeParse(parsed);
  return outline.success ? outline.data : null;
}

/**
 * Cut the part of the book worth sending with a question about the page the
 * highlight sits on: the chapter holding that page when the outline names
 * one, a FALLBACK_WINDOW_PAGES window around it otherwise. The page count is
 * taken from the text itself (its \f seams), never from a stored column, so
 * a mismatch cannot label a whole text as partial or cut past the last page.
 * A text without seams — one-page books, rows stored before the delimiter —
 * is sent whole.
 */
export function selectExcerpt(
  fullText: string,
  selectionPage: number,
  outline: BookOutline | null,
): DocumentExcerpt {
  const pages = fullText.split(PAGE_DELIMITER);
  const totalPages = pages.length;
  if (totalPages <= 1) {
    return {
      text: fullText,
      ranges: [{ startPage: 1, endPage: totalPages }],
      totalPages,
      isPartial: false,
    };
  }

  const page = Math.min(Math.max(selectionPage, 1), totalPages);
  const { startPage, endPage } = chapterBounds(outline, page, totalPages) ?? {
    startPage: Math.max(1, page - FALLBACK_WINDOW_PAGES),
    endPage: Math.min(totalPages, page + FALLBACK_WINDOW_PAGES),
  };

  return {
    text: pages.slice(startPage - 1, endPage).join(PAGE_DELIMITER),
    ranges: [{ startPage, endPage }],
    totalPages,
    isPartial: !(startPage === 1 && endPage === totalPages),
  };
}

/**
 * One part of the book a question can be aimed at: a chapter, or the pages
 * ahead of the first one, which no heading covers.
 */
export interface ChapterSpan {
  /** The chapter's heading, or null for the pages before the first chapter. */
  title: string | null;
  startPage: number;
  endPage: number;
}

/**
 * The chapters of the book, each with the pages it covers.
 *
 * Chapter starts outside the book are dropped; two chapters naming the same
 * start page collapse into the first, so no chapter is ever empty. Pages before
 * the first chapter form a span of their own, unnamed. The spans tile the book
 * between them, which is what lets a reader pick chapters to ask about without
 * leaving a gap the excerpt would silently drop.
 */
export function chapterSpans(outline: BookOutline | null, totalPages: number): ChapterSpan[] {
  if (!outline || totalPages < 1) return [];

  const byStartPage = new Map<number, string>();
  for (const chapter of outline) {
    if (chapter.pageNumber < 1 || chapter.pageNumber > totalPages) continue;
    if (!byStartPage.has(chapter.pageNumber)) byStartPage.set(chapter.pageNumber, chapter.title);
  }

  const starts = [...byStartPage.keys()].sort((a, b) => a - b);
  if (starts.length === 0) return [];

  const bounds = starts[0] === 1 ? starts : [1, ...starts];
  return bounds.map((startPage, index) => ({
    title: byStartPage.get(startPage) ?? null,
    startPage,
    endPage: index + 1 < bounds.length ? bounds[index + 1] - 1 : totalPages,
  }));
}

/** The span holding `page`, or null when the outline gives no usable bounds. */
function chapterBounds(
  outline: BookOutline | null,
  page: number,
  totalPages: number,
): { startPage: number; endPage: number } | null {
  return (
    chapterSpans(outline, totalPages).find(
      (span) => span.startPage <= page && page <= span.endPage,
    ) ?? null
  );
}
