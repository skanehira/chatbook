import type { SelectionRect } from "../../shared/schemas/selection";

export type { SelectionRect } from "../../shared/schemas/selection";

/** Two rects belong to the same line when their tops are within this share of a line's height. */
const SAME_LINE_RATIO = 0.5;

function onSameLine(a: SelectionRect, b: SelectionRect): boolean {
  return Math.abs(a.y - b.y) < Math.min(a.height, b.height) * SAME_LINE_RATIO;
}

function span(a: SelectionRect, b: SelectionRect): SelectionRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * One rect per line of a selection.
 *
 * `Range.getClientRects()` describes the selection piece by piece: pdf.js gives
 * each phrase of a page its own span, so a single line comes back as several
 * rects with the spaces between phrases missing, alongside zero-width caret
 * rects and near-duplicates that differ by a fraction of a pixel. Drawing those
 * as they are leaves the highlight full of holes, and stores the holes with it.
 */
export function tidySelectionRects(rects: SelectionRect[]): SelectionRect[] {
  const lines: SelectionRect[] = [];

  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;

    const index = lines.findIndex((line) => onSameLine(line, rect));
    if (index < 0) {
      lines.push(rect);
    } else {
      lines[index] = span(lines[index], rect);
    }
  }

  return lines;
}

/**
 * Rects with the selection guard's own box removed.
 *
 * `.textLayer.selecting .endOfContent` stretches the guard over the whole page
 * so it can absorb a drag that overshoots a line. When the selection grows past
 * it, the guard is inside the range and contributes its page-sized box, which
 * would then be drawn as a highlight covering everything.
 */
export function dropGuardRect(
  rects: SelectionRect[],
  guard: SelectionRect | null,
): SelectionRect[] {
  if (!guard) return rects;

  // Sub-pixel slack: the two boxes come from separate measurements
  const same = (a: number, b: number) => Math.abs(a - b) <= 1;

  return rects.filter(
    (rect) =>
      !same(rect.x, guard.x) ||
      !same(rect.y, guard.y) ||
      !same(rect.width, guard.width) ||
      !same(rect.height, guard.height),
  );
}

/** A selection ready to be drawn over the page it was made on. */
export interface PageSelection {
  rects: SelectionRect[];
  /** Page width at the time of measuring, so the rects can be rescaled later. */
  pageWidth: number;
}

/**
 * The lines a range covers, measured against the page element rather than the
 * viewport, so they survive scrolling and can be stored with the highlight.
 *
 * DOM-bound, so its behaviour is covered by the end-to-end tests; the pure part
 * is `tidySelectionRects`.
 */
export function selectionOnPage(range: Range, pageElement: Element): PageSelection {
  const page = pageElement.getBoundingClientRect();
  const onPage = (box: DOMRect): SelectionRect => ({
    x: box.left - page.left,
    y: box.top - page.top,
    width: box.width,
    height: box.height,
  });

  const guard = pageElement.querySelector(".endOfContent")?.getBoundingClientRect();

  return {
    rects: tidySelectionRects(
      dropGuardRect(Array.from(range.getClientRects()).map(onPage), guard ? onPage(guard) : null),
    ),
    pageWidth: page.width,
  };
}
