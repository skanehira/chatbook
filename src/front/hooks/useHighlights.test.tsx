import { describe, it, expect } from "vite-plus/test";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { useHighlights, type LoadBook } from "./useHighlights";
import { SwrTestCache } from "../../test/swrTestCache";
import type { BookDetail } from "../../shared/schemas/book";
import type { CreatedSelection, SelectionHighlight } from "../../shared/schemas/selection";

const BOOK_A_ID = "bookA";
const BOOK_B_ID = "bookB";

function highlight(overrides: Partial<SelectionHighlight> = {}): SelectionHighlight {
  return {
    id: "a1",
    selectedText: "エッジはサーバーレス実行基盤です。",
    pageNumber: 1,
    positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
    color: "#FFEB3B",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function book(id: string, selections: SelectionHighlight[]): BookDetail {
  return { id, fileName: `${id}.pdf`, pageCount: 209, hasThumbnail: true, selections };
}

const A_HIGHLIGHTS = [highlight()];
const B_HIGHLIGHTS = [
  highlight({ id: "b1", selectedText: "Durable Objects は処理を集約します。", color: "#2196F3" }),
];

/** A loader the test finishes by hand, so the window before it lands is observable. */
function pausableLoader() {
  const pending = new Map<string, (book: BookDetail) => void>();
  const calls: string[] = [];
  const load: LoadBook = (pdfId) => {
    calls.push(pdfId);
    return new Promise((resolve) => {
      pending.set(pdfId, resolve);
    });
  };

  return {
    load,
    calls,
    finish: async (pdfId: string, selections: SelectionHighlight[]) => {
      await act(async () => {
        pending.get(pdfId)!(book(pdfId, selections));
      });
    },
  };
}

function renderForBook(pdfId: string, load: LoadBook) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache>{children}</SwrTestCache>
  );

  return renderHook(({ id }: { id: string }) => useHighlights(id, load), {
    wrapper,
    initialProps: { id: pdfId },
  });
}

describe("useHighlights", () => {
  it("shows the highlights of the book that is open", async () => {
    const { load, finish } = pausableLoader();
    const view = renderForBook(BOOK_A_ID, load);

    await finish(BOOK_A_ID, A_HIGHLIGHTS);

    expect(view.result.current.highlights).toStrictEqual(A_HIGHLIGHTS);
  });

  it("ignores a book's highlights that land after the reader moved on", async () => {
    const { load, finish } = pausableLoader();
    const view = renderForBook(BOOK_A_ID, load);

    view.rerender({ id: BOOK_B_ID });
    await finish(BOOK_A_ID, A_HIGHLIGHTS);

    expect(view.result.current.highlights).toStrictEqual([]);

    await finish(BOOK_B_ID, B_HIGHLIGHTS);

    expect(view.result.current.highlights).toStrictEqual(B_HIGHLIGHTS);
  });

  it("drops the previous book's highlights while the next book is still loading", async () => {
    const { load, finish } = pausableLoader();
    const view = renderForBook(BOOK_A_ID, load);
    await finish(BOOK_A_ID, A_HIGHLIGHTS);

    view.rerender({ id: BOOK_B_ID });

    expect(view.result.current.highlights).toStrictEqual([]);

    await finish(BOOK_B_ID, B_HIGHLIGHTS);

    expect(view.result.current.highlights).toStrictEqual(B_HIGHLIGHTS);
  });

  it("reads the book once when the viewer and the chat panel both ask for its highlights", async () => {
    const { load, calls, finish } = pausableLoader();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SwrTestCache>{children}</SwrTestCache>
    );
    const view = renderHook(
      () => ({ viewer: useHighlights(BOOK_A_ID, load), panel: useHighlights(BOOK_A_ID, load) }),
      { wrapper },
    );

    await finish(BOOK_A_ID, A_HIGHLIGHTS);

    expect(calls).toStrictEqual([BOOK_A_ID]);
    expect(view.result.current.viewer.highlights).toStrictEqual(A_HIGHLIGHTS);
    expect(view.result.current.panel.highlights).toStrictEqual(A_HIGHLIGHTS);
  });

  it("shows a highlight the viewer just made to the chat panel without re-reading the book", async () => {
    const { load, calls, finish } = pausableLoader();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SwrTestCache>{children}</SwrTestCache>
    );
    const view = renderHook(
      () => ({ viewer: useHighlights(BOOK_A_ID, load), panel: useHighlights(BOOK_A_ID, load) }),
      { wrapper },
    );
    await finish(BOOK_A_ID, A_HIGHLIGHTS);

    const created: CreatedSelection = {
      id: "a2",
      selectedText: "Workers はリクエストごとに分離されます。",
      pageNumber: 12,
      positionData: { rects: [] },
      createdAt: "2026-08-03T10:00:00.000Z",
    };
    await act(async () => {
      view.result.current.viewer.addHighlight(created);
    });

    expect(view.result.current.panel.highlights).toStrictEqual([
      ...A_HIGHLIGHTS,
      { ...created, color: "#FF9800" },
    ]);
    expect(calls).toStrictEqual([BOOK_A_ID]);
  });

  it("gives a highlight saved before colours existed one from the palette", async () => {
    const { load, finish } = pausableLoader();
    const view = renderForBook(BOOK_A_ID, load);

    await finish(BOOK_A_ID, [highlight({ color: "" }), highlight({ id: "a2", color: "" })]);

    expect(view.result.current.highlights.map((h) => h.color)).toStrictEqual([
      "#FFEB3B",
      "#FF9800",
    ]);
  });

  it("has no highlights to show before a book is open", () => {
    const { load, calls } = pausableLoader();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SwrTestCache>{children}</SwrTestCache>
    );
    const view = renderHook(() => useHighlights(undefined, load), { wrapper });

    expect(view.result.current.highlights).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });
});
