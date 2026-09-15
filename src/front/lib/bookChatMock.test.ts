import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { spansFromOutline, mockBookReply } from "./bookChatMock";
import type { BookOutline } from "../../shared/schemas/book";
import type { ScopeChapter } from "./chatScope";

function outline(...entries: [string, number][]): BookOutline {
  return entries.map(([title, pageNumber]) => ({ title, pageNumber }));
}

describe("spansFromOutline", () => {
  it("gives each chapter the pages up to the next one, and the last the end of the book", () => {
    const spans = spansFromOutline(outline(["第2章", 12], ["第3章", 35], ["第4章", 49]), 60);

    expect(spans).toStrictEqual([
      { title: null, startPage: 1, endPage: 11 },
      { title: "第2章", startPage: 12, endPage: 34 },
      { title: "第3章", startPage: 35, endPage: 48 },
      { title: "第4章", startPage: 49, endPage: 60 },
    ]);
  });

  it("adds nothing ahead of a book that opens on a chapter", () => {
    const spans = spansFromOutline(outline(["第1章", 1], ["第2章", 20]), 30);

    expect(spans).toStrictEqual([
      { title: "第1章", startPage: 1, endPage: 19 },
      { title: "第2章", startPage: 20, endPage: 30 },
    ]);
  });

  it("keeps the first of two chapters that name the same page", () => {
    const spans = spansFromOutline(outline(["第1章", 1], ["第1章 つづき", 1], ["第2章", 10]), 20);

    expect(spans).toStrictEqual([
      { title: "第1章", startPage: 1, endPage: 9 },
      { title: "第2章", startPage: 10, endPage: 20 },
    ]);
  });

  it("drops the chapters that start outside the book", () => {
    const spans = spansFromOutline(outline(["はみ出した章", 99], ["第1章", 1]), 20);

    expect(spans).toStrictEqual([{ title: "第1章", startPage: 1, endPage: 20 }]);
  });

  it("holds no chapters for a book with no outline at all", () => {
    expect(spansFromOutline(null, 20)).toStrictEqual([]);
  });

  it("holds no chapters when every one of them starts past the end", () => {
    expect(spansFromOutline(outline(["第9章", 99]), 20)).toStrictEqual([]);
  });
});

describe("mockBookReply", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams the whole answer and names the scope it was asked under", () => {
    vi.useFakeTimers();
    const tokens: string[] = [];
    const done = vi.fn();
    const scope: ScopeChapter[] = [{ title: "第2章", startPage: 12, endPage: 34 }];

    mockBookReply({
      question: "要約して",
      scope,
      pageCount: 60,
      signal: new AbortController().signal,
      onToken: (token) => tokens.push(token),
      onDone: done,
    });
    vi.advanceTimersByTime(60_000);

    const answer = tokens.join("");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(answer);
    expect(answer).toContain("※モック回答（対象: 第2章（12〜34ページ））");
    expect(answer).toContain("要約して");
  });

  it("stops mid-answer once the chat is left, without finishing it", () => {
    vi.useFakeTimers();
    const tokens: string[] = [];
    const done = vi.fn();
    const controller = new AbortController();

    mockBookReply({
      question: "要約して",
      scope: [],
      pageCount: 60,
      signal: controller.signal,
      onToken: (token) => tokens.push(token),
      onDone: done,
    });
    vi.advanceTimersByTime(240);
    const writtenSoFar = tokens.length;
    controller.abort();
    vi.advanceTimersByTime(60_000);

    expect(tokens.length).toBe(writtenSoFar);
    expect(done).not.toHaveBeenCalled();
  });
});
