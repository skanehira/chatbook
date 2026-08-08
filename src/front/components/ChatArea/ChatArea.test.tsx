import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { ChatArea } from "./ChatArea";
import { doneEvent, streamingFetchStub, tokenEvent } from "../../../test/streamingFetchStub";
import {
  activeSelectionAtom,
  chatAbortControllerAtom,
  isStreamingAtom,
  selectionsAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { SelectionHighlight } from "../../../shared/schemas/selection";
import { pdfDocAtom } from "../../atoms/pdfAtom";

const SELECTED_TEXT = "エッジはサーバーレス実行基盤で、実行単位をまたいでメモリを共有できません。";
const OTHER_TEXT = "Durable Objects は単一のインスタンスに処理を集約します。";

const HIGHLIGHTS: SelectionHighlight[] = [
  {
    id: "s1",
    selectedText: SELECTED_TEXT,
    pageNumber: 42,
    positionData: { rects: [] },
    color: "#FFEB3B",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "s2",
    selectedText: OTHER_TEXT,
    pageNumber: 7,
    positionData: { rects: [] },
    color: "#2196F3",
    createdAt: "2026-08-02T10:00:00.000Z",
  },
];

function renderChat(options: { activeSelection?: ActiveSelection | null } = {}) {
  const { activeSelection = { id: "s1", selectedText: SELECTED_TEXT, pageNumber: 42 } } = options;
  const store = createStore();
  store.set(pdfDocAtom, { id: "p1", fileName: "Cloudflare Workers.pdf", pageCount: 209 });
  store.set(activeSelectionAtom, activeSelection);
  store.set(selectionsAtom, HIGHLIGHTS);

  const opened: ActiveSelection[] = [];
  render(
    <Provider store={store}>
      <ChatArea onSelectionClick={(selection) => opened.push(selection)} />
    </Provider>,
  );
  return { store, opened };
}

describe("ChatArea", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the question at once, then the answer as it streams in", async () => {
    // ChatArea's own fetch stands in for the chat endpoint, so the question
    // going through useChatStream — what makes it appear before the model
    // answers — is exercised rather than assumed.
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    renderChat();

    await userEvent.type(screen.getByPlaceholderText("質問を入力..."), "この段落を一言で要約して");
    await userEvent.keyboard("{Enter}");

    // The question and the wait are on screen before a single token arrives
    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/^考え中…$/);

    await act(async () => {
      calls[0].emit(tokenEvent("要約すると"));
    });
    await waitFor(() => expect(screen.getByText("要約すると")).toBeVisible());
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      calls[0].emit(tokenEvent("、選択の話です。"));
      calls[0].emit(doneEvent("m1"));
      calls[0].end();
    });

    await waitFor(() => expect(screen.getByText("要約すると、選択の話です。")).toBeVisible());
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      [
        "/api/pdf/p1/selections/s1/chats",
        { content: "この段落を一言で要約して", useWebSearch: true },
      ],
    ]);
  });

  it("shows the selected passage the question is about", () => {
    renderChat();

    expect(screen.getByText(SELECTED_TEXT)).toBeInTheDocument();
  });

  it("lists the book's highlights while no passage is selected", () => {
    renderChat({ activeSelection: null });

    expect(screen.getByText("ハイライト 2件")).toBeInTheDocument();
    expect(screen.getByText(OTHER_TEXT)).toBeInTheDocument();
  });

  it("hands the highlight picked from the list to onSelectionClick", async () => {
    const { opened } = renderChat({ activeSelection: null });

    await userEvent.click(screen.getByText(OTHER_TEXT));

    expect(opened).toEqual([{ id: "s2", selectedText: OTHER_TEXT, pageNumber: 7 }]);
  });

  it("returns to the highlight list when the chat is left", async () => {
    const { store } = renderChat();

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));

    expect(store.get(activeSelectionAtom)).toBeNull();
    expect(screen.getByText("ハイライト 2件")).toBeInTheDocument();
  });

  it("stops the answer being streamed when the chat is left", async () => {
    const { store } = renderChat();
    const controller = new AbortController();
    store.set(chatAbortControllerAtom, controller);
    store.set(isStreamingAtom, true);

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));

    expect(controller.signal.aborted).toBe(true);
    expect(store.get(isStreamingAtom)).toBe(false);
    expect(screen.getByText("ハイライト 2件")).toBeInTheDocument();
  });
});
