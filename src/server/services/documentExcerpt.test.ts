import { describe, it, expect } from "vite-plus/test";
import {
  chapterSpans,
  describePages,
  selectExcerpt,
  selectRanges,
  readStoredOutline,
  FALLBACK_WINDOW_PAGES,
} from "./documentExcerpt";

/** pdfLoader が作る fullText と同じ形 (ページ区切りは \f) */
function fullTextOf(...pages: string[]): string {
  return pages.join("\f");
}

/** n ページの本文を "p1" … "pn" で作る */
function bookOf(pageCount: number): string {
  return fullTextOf(...Array.from({ length: pageCount }, (_, i) => `p${i + 1}`));
}

/** startPage〜endPage をそのまま切った期待テキスト */
function pagesText(startPage: number, endPage: number): string {
  return Array.from({ length: endPage - startPage + 1 }, (_, i) => `p${startPage + i}`).join("\f");
}

describe("selectExcerpt", () => {
  const OUTLINE = [
    { title: "第1章", pageNumber: 2 },
    { title: "第2章", pageNumber: 5 },
    { title: "第3章", pageNumber: 9 },
  ];

  it("sends only the chapter that holds the highlighted page", () => {
    expect(selectExcerpt(bookOf(12), 6, OUTLINE)).toStrictEqual({
      text: pagesText(5, 8),
      ranges: [{ startPage: 5, endPage: 8 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("counts a chapter's opening page as part of that chapter, not the one before", () => {
    expect(selectExcerpt(bookOf(12), 5, OUTLINE)).toStrictEqual({
      text: pagesText(5, 8),
      ranges: [{ startPage: 5, endPage: 8 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("runs the last chapter to the final page of the book", () => {
    expect(selectExcerpt(bookOf(12), 10, OUTLINE)).toStrictEqual({
      text: pagesText(9, 12),
      ranges: [{ startPage: 9, endPage: 12 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("treats pages before the first chapter as front matter of their own", () => {
    expect(selectExcerpt(bookOf(12), 1, OUTLINE)).toStrictEqual({
      text: pagesText(1, 1),
      ranges: [{ startPage: 1, endPage: 1 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("hands back the whole book, marked whole, when its one chapter spans it", () => {
    expect(selectExcerpt(bookOf(3), 2, [{ title: "全部", pageNumber: 1 }])).toStrictEqual({
      text: pagesText(1, 3),
      ranges: [{ startPage: 1, endPage: 3 }],
      totalPages: 3,
      isPartial: false,
    });
  });

  it("keeps the excerpt a verbatim slice of the full text", () => {
    const fullText = bookOf(12);

    // The excerpt must sit in the full text exactly where its first page does:
    // an empty excerpt (indexOf "" is 0) or one with anything injected into it
    // (indexOf -1) both land somewhere else.
    expect(fullText.indexOf(selectExcerpt(fullText, 6, OUTLINE).text)).toBe(fullText.indexOf("p5"));
  });

  it("keeps a chapter starting on page 1 whole, with no front matter split off it", () => {
    const outline = [
      { title: "第1章", pageNumber: 1 },
      { title: "第2章", pageNumber: 5 },
    ];

    expect(selectExcerpt(bookOf(12), 3, outline)).toStrictEqual({
      text: pagesText(1, 4),
      ranges: [{ startPage: 1, endPage: 4 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("orders an unsorted outline before cutting chapter bounds", () => {
    const shuffled = [OUTLINE[2], OUTLINE[0], OUTLINE[1]];

    expect(selectExcerpt(bookOf(12), 6, shuffled)).toStrictEqual({
      text: pagesText(5, 8),
      ranges: [{ startPage: 5, endPage: 8 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("lets the first of two chapters naming the same start page win", () => {
    const doubled = [
      { title: "第1章", pageNumber: 2 },
      { title: "第2章", pageNumber: 5 },
      { title: "第2章の重複", pageNumber: 5 },
      { title: "第3章", pageNumber: 9 },
    ];

    expect(selectExcerpt(bookOf(12), 5, doubled)).toStrictEqual({
      text: pagesText(5, 8),
      ranges: [{ startPage: 5, endPage: 8 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("ignores chapters pointing outside the book", () => {
    const stray = [...OUTLINE, { title: "落丁", pageNumber: 99 }];

    expect(selectExcerpt(bookOf(12), 10, stray)).toStrictEqual({
      text: pagesText(9, 12),
      ranges: [{ startPage: 9, endPage: 12 }],
      totalPages: 12,
      isPartial: true,
    });
  });

  it("falls back to the page window when every chapter points outside the book", () => {
    const stray = [{ title: "落丁", pageNumber: 99 }];

    expect(selectExcerpt(bookOf(30), 15, stray)).toStrictEqual({
      text: pagesText(5, 25),
      ranges: [{ startPage: 5, endPage: 25 }],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("cuts a window around the highlight when the book has no outline", () => {
    expect(selectExcerpt(bookOf(30), 15, null)).toStrictEqual({
      text: pagesText(15 - FALLBACK_WINDOW_PAGES, 15 + FALLBACK_WINDOW_PAGES),
      ranges: [{ startPage: 5, endPage: 25 }],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("stops the window at the front cover rather than asking for page zero", () => {
    expect(selectExcerpt(bookOf(30), 2, null)).toStrictEqual({
      text: pagesText(1, 12),
      ranges: [{ startPage: 1, endPage: 12 }],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("stops the window at the back cover rather than past the book", () => {
    expect(selectExcerpt(bookOf(30), 29, null)).toStrictEqual({
      text: pagesText(19, 30),
      ranges: [{ startPage: 19, endPage: 30 }],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("hands back a window that covers a small book whole, marked whole", () => {
    expect(selectExcerpt(bookOf(12), 6, null)).toStrictEqual({
      text: pagesText(1, 12),
      ranges: [{ startPage: 1, endPage: 12 }],
      totalPages: 12,
      isPartial: false,
    });
  });

  it("hands back a legacy text without page breaks whole", () => {
    expect(selectExcerpt("切れ目の無い 本文", 3, OUTLINE)).toStrictEqual({
      text: "切れ目の無い 本文",
      ranges: [{ startPage: 1, endPage: 1 }],
      totalPages: 1,
      isPartial: false,
    });
  });

  it("pulls a highlight pointing past the book back to the last page", () => {
    expect(selectExcerpt(bookOf(12), 99, OUTLINE)).toStrictEqual({
      text: pagesText(9, 12),
      ranges: [{ startPage: 9, endPage: 12 }],
      totalPages: 12,
      isPartial: true,
    });
  });
});

describe("describePages", () => {
  it("names a run of pages by the two ends of it", () => {
    expect(describePages([{ startPage: 5, endPage: 8 }])).toBe("5-8");
  });

  it("lists the runs a reader picked apart, in the order they are cut", () => {
    expect(
      describePages([
        { startPage: 5, endPage: 8 },
        { startPage: 35, endPage: 40 },
      ]),
    ).toBe("5-8, 35-40");
  });
});

describe("selectRanges", () => {
  it("cuts the pages the reader asked about", () => {
    expect(selectRanges(bookOf(30), [{ startPage: 12, endPage: 14 }])).toStrictEqual({
      text: pagesText(12, 14),
      ranges: [{ startPage: 12, endPage: 14 }],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("takes the chapters picked and leaves the pages between them out", () => {
    expect(
      selectRanges(bookOf(30), [
        { startPage: 5, endPage: 8 },
        { startPage: 20, endPage: 22 },
      ]),
    ).toStrictEqual({
      text: fullTextOf(pagesText(5, 8), pagesText(20, 22)),
      ranges: [
        { startPage: 5, endPage: 8 },
        { startPage: 20, endPage: 22 },
      ],
      totalPages: 30,
      isPartial: true,
    });
  });

  it("runs ranges that touch together, so the pages joining them are not cut twice", () => {
    expect(
      selectRanges(bookOf(30), [
        { startPage: 5, endPage: 8 },
        { startPage: 9, endPage: 12 },
      ]).ranges,
    ).toStrictEqual([{ startPage: 5, endPage: 12 }]);
    // Two chapters read front to back are then one run, which is what keeps the
    // excerpt a verbatim slice of the book rather than a stitched one.
    expect(
      selectRanges(bookOf(30), [
        { startPage: 9, endPage: 12 },
        { startPage: 5, endPage: 8 },
      ]).text,
    ).toBe(pagesText(5, 12));
  });

  it("pulls a range that runs past the ends of the book back into it", () => {
    expect(selectRanges(bookOf(30), [{ startPage: 1, endPage: 99 }]).ranges).toStrictEqual([
      { startPage: 1, endPage: 30 },
    ]);
  });

  it("drops a range that lies outside the book altogether", () => {
    expect(
      selectRanges(bookOf(30), [
        { startPage: 40, endPage: 45 },
        { startPage: 3, endPage: 4 },
      ]).ranges,
    ).toStrictEqual([{ startPage: 3, endPage: 4 }]);
  });

  it("asks about the whole book when nothing picked is in it", () => {
    // A book whose stored page count disagrees with its own page breaks would
    // otherwise leave the reader a question with nothing to ask it about.
    expect(selectRanges(bookOf(30), [{ startPage: 40, endPage: 45 }]).ranges).toStrictEqual([
      { startPage: 1, endPage: 30 },
    ]);
  });

  it("marks the excerpt whole, and says nothing about parts, when it is the book", () => {
    expect(selectRanges(bookOf(12), [{ startPage: 1, endPage: 12 }])).toStrictEqual({
      text: pagesText(1, 12),
      ranges: [{ startPage: 1, endPage: 12 }],
      totalPages: 12,
      isPartial: false,
    });
  });

  it("hands back a text without page breaks whole", () => {
    expect(selectRanges("切れ目の無い 本文", [{ startPage: 1, endPage: 5 }])).toStrictEqual({
      text: "切れ目の無い 本文",
      ranges: [{ startPage: 1, endPage: 1 }],
      totalPages: 1,
      isPartial: false,
    });
  });

  it("keeps every run a verbatim slice of the full text", () => {
    const fullText = bookOf(30);
    const excerpt = selectRanges(fullText, [
      { startPage: 5, endPage: 8 },
      { startPage: 20, endPage: 22 },
    ]);

    // Each run has to sit in the book exactly where its own first page does:
    // anything injected between the runs would join one chapter's end to the
    // next one's start, and a quote taken across that seam would be a passage
    // findPageNumber cannot find in the book at all.
    expect(excerpt.text.indexOf(pagesText(5, 8))).toBe(0);
    expect(excerpt.text.lastIndexOf(pagesText(20, 22))).toBe(pagesText(5, 8).length + 1);
  });
});

describe("chapterSpans", () => {
  const OUTLINE = [
    { title: "第1章", pageNumber: 2 },
    { title: "第2章", pageNumber: 5 },
    { title: "第3章", pageNumber: 9 },
  ];

  it("gives each chapter the pages up to the next one, and the last the end of the book", () => {
    // The pages ahead of the first chapter are a span of their own, unnamed
    // because the book gave them no heading.
    expect(chapterSpans(OUTLINE, 12)).toStrictEqual([
      { title: null, startPage: 1, endPage: 1 },
      { title: "第1章", startPage: 2, endPage: 4 },
      { title: "第2章", startPage: 5, endPage: 8 },
      { title: "第3章", startPage: 9, endPage: 12 },
    ]);
  });

  it("adds nothing ahead of a book that opens on a chapter", () => {
    expect(
      chapterSpans(
        [
          { title: "第1章", pageNumber: 1 },
          { title: "第2章", pageNumber: 5 },
        ],
        8,
      ),
    ).toStrictEqual([
      { title: "第1章", startPage: 1, endPage: 4 },
      { title: "第2章", startPage: 5, endPage: 8 },
    ]);
  });

  it("keeps the first of two chapters naming the same start page", () => {
    expect(
      chapterSpans(
        [
          { title: "第1章", pageNumber: 2 },
          { title: "第1章の重複", pageNumber: 2 },
        ],
        6,
      ),
    ).toStrictEqual([
      { title: null, startPage: 1, endPage: 1 },
      { title: "第1章", startPage: 2, endPage: 6 },
    ]);
  });

  it("drops the chapters that start outside the book", () => {
    expect(
      chapterSpans(
        [
          { title: "落丁", pageNumber: 99 },
          { title: "第1章", pageNumber: 2 },
        ],
        6,
      ),
    ).toStrictEqual([
      { title: null, startPage: 1, endPage: 1 },
      { title: "第1章", startPage: 2, endPage: 6 },
    ]);
  });

  it("holds no chapters for a book with no outline, or none that fits in it", () => {
    expect(chapterSpans(null, 12)).toStrictEqual([]);
    expect(chapterSpans([{ title: "落丁", pageNumber: 99 }], 12)).toStrictEqual([]);
  });
});

describe("readStoredOutline", () => {
  it("hands back the chapters a stored column holds", () => {
    expect(readStoredOutline('[{"title":"第1章","pageNumber":2}]')).toStrictEqual([
      { title: "第1章", pageNumber: 2 },
    ]);
  });

  it("reads a column stored as NULL as a book without an outline", () => {
    expect(readStoredOutline(null)).toBeNull();
  });

  it("reads a column that is not JSON as a book without an outline", () => {
    expect(readStoredOutline("{broken")).toBeNull();
  });

  it("reads JSON of the wrong shape as a book without an outline", () => {
    expect(readStoredOutline('[{"title":"章だけでページが無い"}]')).toBeNull();
  });
});
