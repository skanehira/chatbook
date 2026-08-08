import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { ChatArea } from "./ChatArea";
import {
  doneEvent,
  errorEvent,
  streamingFetchStub,
  tokenEvent,
} from "../../../test/streamingFetchStub";
import {
  activeSelectionAtom,
  chatAbortControllerAtom,
  isStreamingAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { SelectionHighlight } from "../../../shared/schemas/selection";
import type { BookDetail } from "../../../shared/schemas/book";
import { bookKey } from "../../hooks/useBook";
import { SwrTestCache } from "../../../test/swrTestCache";

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

const BOOK: BookDetail = {
  id: "p1",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  selections: HIGHLIGHTS,
};

function renderChat(
  options: {
    activeSelection?: ActiveSelection | null;
    /** Set to render the panel as it looks when the book itself failed to load. */
    bookError?: Error;
  } = {},
) {
  const { activeSelection = { id: "s1", selectedText: SELECTED_TEXT, pageNumber: 42 }, bookError } =
    options;
  const book = bookError ? undefined : BOOK;
  const store = createStore();
  store.set(activeSelectionAtom, activeSelection);

  const opened: ActiveSelection[] = [];
  render(
    // The highlights the panel lists come from the book's cache entry, the same
    // one the viewer draws from. A book that failed to load has no such entry,
    // so seeding one would contradict the state under test.
    <SwrTestCache seed={book ? { [bookKey(BOOK.id)]: BOOK } : {}}>
      <Provider store={store}>
        <ChatArea
          book={book}
          bookError={bookError}
          onSelectionClick={(selection) => opened.push(selection)}
        />
      </Provider>
    </SwrTestCache>,
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

  it("says why the answer never came instead of leaving the question unanswered", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    renderChat();

    await userEvent.type(screen.getByPlaceholderText("質問を入力..."), "この段落を一言で要約して");
    await userEvent.keyboard("{Enter}");
    await act(async () => {
      calls[0].emit(errorEvent("AI_API_ERROR", "upstream is down"));
      calls[0].end();
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /^回答の取得に失敗しました: upstream is down$/,
      ),
    );
    // The question stays on screen, and the wait that would suggest an answer
    // is still coming is over
    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the selected passage the question is about", () => {
    renderChat();

    expect(screen.getByText(SELECTED_TEXT)).toBeInTheDocument();
  });

  it("says the book could not be read rather than showing it as one without highlights", () => {
    // The highlights come from the book itself, so a book that failed to load
    // is indistinguishable from one nobody has marked up yet.
    renderChat({ activeSelection: null, bookError: new Error("PDF not found") });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /^ハイライトを読み込めませんでした: PDF not found$/,
    );
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
