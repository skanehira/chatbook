import { describe, it, expect } from "vite-plus/test";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { useHighlights, type LoadSelections } from "./useHighlights";
import { selectionsAtom } from "../atoms/chatAtom";
import type { SelectionHighlight } from "../../shared/schemas/selection";
import type { PdfDoc } from "../atoms/pdfAtom";

const BOOK_A: PdfDoc = { id: "bookA", fileName: "Workers.pdf", pageCount: 209 };
const BOOK_B: PdfDoc = { id: "bookB", fileName: "Durable Objects.pdf", pageCount: 120 };

function highlight(id: string, selectedText: string): SelectionHighlight {
  return {
    id,
    selectedText,
    pageNumber: 1,
    positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
    color: "#FFEB3B",
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

const A_HIGHLIGHTS = [highlight("a1", "エッジはサーバーレス実行基盤です。")];
const B_HIGHLIGHTS = [highlight("b1", "Durable Objects は処理を集約します。")];

/** A loader the test finishes by hand, so the window before it lands is observable. */
function pausableLoader() {
  const pending = new Map<string, (highlights: SelectionHighlight[]) => void>();
  const load: LoadSelections = (pdfId) =>
    new Promise((resolve) => {
      pending.set(pdfId, resolve);
    });

  return {
    load,
    finish: async (pdfId: string, highlights: SelectionHighlight[]) => {
      await act(async () => {
        pending.get(pdfId)!(highlights);
      });
    },
  };
}

function renderForBook(book: PdfDoc, load: LoadSelections) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  const view = renderHook(({ pdfDoc }: { pdfDoc: PdfDoc }) => useHighlights(pdfDoc, load), {
    wrapper,
    initialProps: { pdfDoc: book },
  });
  return { store, view };
}

describe("useHighlights", () => {
  it("shares the highlights of the book that is open", async () => {
    const { load, finish } = pausableLoader();
    const { store } = renderForBook(BOOK_A, load);

    await finish(BOOK_A.id, A_HIGHLIGHTS);

    expect(store.get(selectionsAtom)).toEqual(A_HIGHLIGHTS);
  });

  it("ignores a book's highlights that land after the reader moved on", async () => {
    const { load, finish } = pausableLoader();
    const { store, view } = renderForBook(BOOK_A, load);

    view.rerender({ pdfDoc: BOOK_B });
    await finish(BOOK_A.id, A_HIGHLIGHTS);

    expect(store.get(selectionsAtom)).toEqual([]);

    await finish(BOOK_B.id, B_HIGHLIGHTS);

    expect(store.get(selectionsAtom)).toEqual(B_HIGHLIGHTS);
  });

  it("drops the previous book's highlights while the next book is still loading", async () => {
    const { load, finish } = pausableLoader();
    const { store, view } = renderForBook(BOOK_A, load);
    await finish(BOOK_A.id, A_HIGHLIGHTS);

    view.rerender({ pdfDoc: BOOK_B });

    expect(store.get(selectionsAtom)).toEqual([]);

    await finish(BOOK_B.id, B_HIGHLIGHTS);

    expect(store.get(selectionsAtom)).toEqual(B_HIGHLIGHTS);
  });
});
