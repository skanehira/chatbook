import type { PageRange } from "../../shared/schemas/chat";
import type { BookChapter } from "../../shared/schemas/book";

/**
 * One part of the book a question can be aimed at: a chapter of the table of
 * contents, or the pages before the first one, which no heading covers.
 *
 * The shape is the server's — it works the pages out from the outline it
 * stores, so that what the reader picks and what an excerpt is cut by cannot
 * disagree. This is the name the panel knows it by.
 */
export type ScopeChapter = BookChapter;

/**
 * The pages a question under this scope sends. Nothing picked is the whole
 * book, which is a range like any other rather than a second way of saying it.
 */
export function scopeRanges(scope: ScopeChapter[], pageCount: number): PageRange[] {
  if (scope.length === 0) return [{ startPage: 1, endPage: pageCount }];
  return scope.map(({ startPage, endPage }) => ({ startPage, endPage }));
}

/** What the pages ahead of the first chapter are called, having no heading. */
const FRONT_MATTER_LABEL = "冒頭";

/** A chapter's name as the reader sees it, in the chip and in the menu. */
export function chapterLabel(chapter: { title: string | null }): string {
  return chapter.title ?? FRONT_MATTER_LABEL;
}

/**
 * What the scope chip says. Nothing picked is the whole book, and once several
 * chapters are picked the rest are counted rather than listed: the chip sits in
 * a header row that a narrow sheet has to keep to one line.
 */
export function scopeLabel(scope: ScopeChapter[]): string {
  const [first] = scope;
  if (first === undefined) return "本全体";
  return scope.length === 1
    ? chapterLabel(first)
    : `${chapterLabel(first)} ほか${scope.length - 1}件`;
}

/** The pages a chapter covers, as the reader counts them. */
export function pageRangeLabel(range: { startPage: number; endPage: number }): string {
  return range.startPage === range.endPage
    ? `${range.startPage}ページ`
    : `${range.startPage}〜${range.endPage}ページ`;
}
