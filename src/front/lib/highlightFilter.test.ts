import { describe, it, expect } from "vite-plus/test";
import { filterHighlights, parsePageBound, type HighlightFilter } from "./highlightFilter";

const EDGE = { id: "01JEDGE", selectedText: "エッジは Edge Runtime 上で動きます", pageNumber: 7 };
const KV = { id: "01JKV", selectedText: "KV はエッジから読めますが結果整合です", pageNumber: 42 };
const DO = { id: "01JDO", selectedText: "Durable Objects は処理を集約します", pageNumber: 88 };

const ALL = [EDGE, KV, DO];
const NOTHING_FILLED_IN: HighlightFilter = { query: "", pageFrom: null, pageTo: null };

describe("filterHighlights", () => {
  it("keeps every highlight while the reader has filled nothing in", () => {
    expect(filterHighlights(ALL, NOTHING_FILLED_IN)).toStrictEqual([EDGE, KV, DO]);
  });

  it("keeps only the highlights whose passage contains the query", () => {
    expect(filterHighlights(ALL, { ...NOTHING_FILLED_IN, query: "結果整合" })).toStrictEqual([KV]);
  });

  it("matches a query typed in a different case than the passage", () => {
    expect(filterHighlights(ALL, { ...NOTHING_FILLED_IN, query: "edge runtime" })).toStrictEqual([
      EDGE,
    ]);
  });

  it("ignores the spaces around a query, so a stray space does not empty the list", () => {
    expect(filterHighlights(ALL, { ...NOTHING_FILLED_IN, query: "  結果整合  " })).toStrictEqual([
      KV,
    ]);
  });

  it("treats a query of nothing but spaces as no query at all", () => {
    expect(filterHighlights(ALL, { ...NOTHING_FILLED_IN, query: "   " })).toStrictEqual([
      EDGE,
      KV,
      DO,
    ]);
  });

  it("keeps the highlights sitting on the first and last page of the range", () => {
    expect(filterHighlights(ALL, { query: "", pageFrom: 7, pageTo: 42 })).toStrictEqual([EDGE, KV]);
  });

  it("keeps everything from the given page on when no last page is given", () => {
    expect(filterHighlights(ALL, { query: "", pageFrom: 42, pageTo: null })).toStrictEqual([
      KV,
      DO,
    ]);
  });

  it("keeps everything up to the given page when no first page is given", () => {
    expect(filterHighlights(ALL, { query: "", pageFrom: null, pageTo: 42 })).toStrictEqual([
      EDGE,
      KV,
    ]);
  });

  it("finds nothing when the range is asked to start after it ends", () => {
    // Swapping the two would answer a question the reader did not ask; an empty
    // list says plainly that the range as typed holds nothing.
    expect(filterHighlights(ALL, { query: "", pageFrom: 88, pageTo: 7 })).toStrictEqual([]);
  });

  it("narrows by the query and the page range together", () => {
    expect(filterHighlights(ALL, { query: "エッジ", pageFrom: 42, pageTo: null })).toStrictEqual([
      KV,
    ]);
  });

  it("leaves the highlights in the order they were given", () => {
    expect(filterHighlights([DO, EDGE, KV], NOTHING_FILLED_IN)).toStrictEqual([DO, EDGE, KV]);
  });

  it("leaves the list it was handed untouched", () => {
    const given = [EDGE, KV, DO];

    filterHighlights(given, { query: "エッジ", pageFrom: 1, pageTo: 10 });

    expect(given).toStrictEqual([EDGE, KV, DO]);
  });
});

describe("parsePageBound", () => {
  it("reads the page number the reader typed", () => {
    expect(parsePageBound("12")).toBe(12);
  });

  it("reads a page number typed with spaces around it", () => {
    expect(parsePageBound(" 12 ")).toBe(12);
  });

  it("reads a page number typed with a Japanese IME left on", () => {
    // The reader is reading a Japanese book, so the IME is on more often than
    // not; full-width digits mean the same page.
    expect(parsePageBound("１２")).toBe(12);
    expect(parsePageBound("　７　")).toBe(7);
  });

  it("treats an empty box as no bound", () => {
    expect(parsePageBound("")).toBeNull();
  });

  it("treats a box holding only spaces as no bound", () => {
    expect(parsePageBound("   ")).toBeNull();
  });

  it("treats text that is not a number as no bound", () => {
    expect(parsePageBound("abc")).toBeNull();
  });

  it("treats the other ways JavaScript spells a number as no bound", () => {
    // A reader typing into a page box means digits; reading "0x10" as page 16
    // would be the language's answer to a question nobody asked.
    expect(parsePageBound("0x10")).toBeNull();
    expect(parsePageBound("1e3")).toBeNull();
    expect(parsePageBound("0b101")).toBeNull();
  });

  it("treats a page number below the first page as no bound", () => {
    expect(parsePageBound("0")).toBeNull();
    expect(parsePageBound("-1")).toBeNull();
  });

  it("treats a fraction of a page as no bound, since pages are counted whole", () => {
    expect(parsePageBound("1.5")).toBeNull();
  });
});
