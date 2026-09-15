import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { errAsync, okAsync } from "neverthrow";
import type { ReactNode } from "react";
import { useAskAboutSelection, type SaveSelection } from "./useAskAboutSelection";
import {
  activeSelectionAtom,
  bookChatOpenAtom,
  chatMessagesAtom,
  chatPanelOpenAtom,
  chatSheetAtom,
} from "../atoms/chatAtom";
import { ApiError } from "../lib/fetcher";
import { streamingFetchStub } from "../../test/streamingFetchStub";
import { PHONE_WIDTH, setViewportWidth } from "../../test/viewport";
import type { CreatedSelection } from "../../shared/schemas/selection";

const PDF_ID = "p1";
const QUESTION = "この段落を一言で要約して";
const PASSAGE = "エッジはサーバーレス実行基盤です。";

const DRAFT = {
  selectedText: PASSAGE,
  pageNumber: 42,
  positionData: { rects: [{ x: 10, y: 20, width: 100, height: 16 }], pageWidth: 600 },
};

const STORED: CreatedSelection = {
  id: "s1",
  selectedText: PASSAGE,
  pageNumber: 42,
  positionData: { rects: [{ x: 10, y: 20, width: 100, height: 16 }], pageWidth: 600 },
  createdAt: "2026-08-01T10:00:00.000Z",
};

/** `seed` runs before the hook mounts, for the tests that start part way in. */
function renderAsk(
  saveSelection: SaveSelection,
  seed?: (store: ReturnType<typeof createStore>) => void,
) {
  const store = createStore();
  seed?.(store);
  const added: CreatedSelection[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  return {
    store,
    added,
    view: renderHook(
      () => useAskAboutSelection((selection) => added.push(selection), saveSelection),
      { wrapper },
    ),
  };
}

describe("useAskAboutSelection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the highlight, opens its chat and asks the question once it is stored", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, added, view } = renderAsk(() => okAsync(STORED));

    await act(async () => {
      await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    expect(added).toStrictEqual([STORED]);
    expect(store.get(activeSelectionAtom)).toStrictEqual({
      id: "s1",
      selectedText: PASSAGE,
      pageNumber: 42,
    });
    await waitFor(() =>
      expect(calls.map((call) => [call.url, call.body])).toStrictEqual([
        ["/api/pdf/p1/selections/s1/chats", { content: QUESTION, useWebSearch: false }],
      ]),
    );
    expect(view.result.current.saveError).toBeNull();
  });

  it("draws the sheet up on one column so the answer is not asked for off screen", async () => {
    // The sheet starts closed on a phone, so an answer streamed into it lands
    // out of sight unless asking a question is itself taken as asking for it.
    setViewportWidth(PHONE_WIDTH);
    const { fetchFn } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, view } = renderAsk(() => okAsync(STORED));

    await act(async () => {
      await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    expect(store.get(chatSheetAtom)).toBe("half");
  });

  it("leaves a sheet the reader had already pulled to full where it is", async () => {
    setViewportWidth(PHONE_WIDTH);
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, view } = renderAsk(
      () => okAsync(STORED),
      (seeded) => seeded.set(chatSheetAtom, "full"),
    );

    await act(async () => {
      await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    // Pulling the sheet back down to half to answer a question would take the
    // book back over the answer the reader had made room for.
    expect(store.get(chatSheetAtom)).toBe("full");
    await waitFor(() =>
      expect(calls.map((call) => [call.url, call.body])).toStrictEqual([
        ["/api/pdf/p1/selections/s1/chats", { content: QUESTION, useWebSearch: false }],
      ]),
    );
  });

  it("unfolds a chat panel the reader had hidden on a wide screen", async () => {
    const { fetchFn } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, view } = renderAsk(
      () => okAsync(STORED),
      (seeded) => seeded.set(chatPanelOpenAtom, false),
    );

    await act(async () => {
      await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    expect(store.get(chatPanelOpenAtom)).toBe(true);
  });

  it("leaves the book's own conversation behind for the passage's", async () => {
    // Asking about a passage is the third way into a conversation, after the
    // list and the URL, and the panel shows one at a time: the book's own
    // thread left standing would be the face the reader came back to when they
    // left this one, rather than the list they asked for.
    const { fetchFn } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, view } = renderAsk(
      () => okAsync(STORED),
      (seed) => seed.set(bookChatOpenAtom, true),
    );

    await act(async () => {
      await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    expect(store.get(activeSelectionAtom)).toStrictEqual({
      id: STORED.id,
      selectedText: STORED.selectedText,
      pageNumber: STORED.pageNumber,
    });
    expect(store.get(bookChatOpenAtom)).toBe(false);
  });

  it("says the highlight could not be saved and asks nothing about it", async () => {
    // Asking about a passage that was never stored would stream an answer into
    // a conversation with nothing to attach it to. On one column that also
    // means the sheet stays down: there is nothing in it to show.
    setViewportWidth(PHONE_WIDTH);
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { store, added, view } = renderAsk(() =>
      errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
    );

    let asked!: Awaited<ReturnType<typeof view.result.current.askAboutSelection>>;
    await act(async () => {
      asked = await view.result.current.askAboutSelection(PDF_ID, DRAFT, QUESTION, false);
    });

    const failure = asked._unsafeUnwrapErr();
    expect([failure.message, failure.code, failure.status, failure.kind]).toStrictEqual([
      "PDF not found",
      "PDF_NOT_FOUND",
      404,
      "http",
    ]);
    expect(view.result.current.saveError).toBe("PDF not found");
    expect(added).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
    expect(store.get(activeSelectionAtom)).toBeNull();
    expect(store.get(chatMessagesAtom)).toStrictEqual([]);
    expect(store.get(chatSheetAtom)).toBe("closed");
  });
});
