import { describe, it, expect } from "vite-plus/test";
import { chapterLabel, pageRangeLabel, scopeLabel, type ScopeChapter } from "./chatScope";

function chapter(title: string | null, startPage: number, endPage: number): ScopeChapter {
  return { title, startPage, endPage };
}

const V8 = chapter("第2章 V8 とアイソレート", 12, 34);
const DURABLE_OBJECTS = chapter("第3章 Durable Objects", 35, 48);
const R2 = chapter("第4章 R2", 49, 60);

describe("scopeLabel", () => {
  it("says the whole book while the reader has picked nothing", () => {
    expect(scopeLabel([])).toBe("本全体");
  });

  it("names the chapter a question is aimed at", () => {
    expect(scopeLabel([V8])).toBe("第2章 V8 とアイソレート");
  });

  it("counts the rest rather than listing every chapter picked", () => {
    expect(scopeLabel([V8, DURABLE_OBJECTS, R2])).toBe("第2章 V8 とアイソレート ほか2件");
  });
});

describe("chapterLabel", () => {
  it("uses the heading the book gave the chapter", () => {
    expect(chapterLabel(V8)).toBe("第2章 V8 とアイソレート");
  });

  it("names the pages before the first chapter, which carry no heading", () => {
    expect(chapterLabel({ title: null })).toBe("冒頭");
  });
});

describe("pageRangeLabel", () => {
  it("counts the pages of a chapter that runs over several", () => {
    expect(pageRangeLabel({ startPage: 12, endPage: 34 })).toBe("12〜34ページ");
  });

  it("says the page once when the chapter is a single page", () => {
    expect(pageRangeLabel({ startPage: 12, endPage: 12 })).toBe("12ページ");
  });
});
