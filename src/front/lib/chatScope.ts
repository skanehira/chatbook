/**
 * One part of the book a question can be aimed at: a chapter of the table of
 * contents, or the pages before the first one, which no heading covers.
 */
export interface ScopeChapter {
  /** The chapter's heading, or null for the pages ahead of the first chapter. */
  title: string | null;
  startPage: number;
  endPage: number;
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
