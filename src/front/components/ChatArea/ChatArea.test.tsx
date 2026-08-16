import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { okAsync, ResultAsync } from "neverthrow";
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
  chatMessagesAtom,
  isStreamingAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { ChatQuoteSelection } from "../../lib/chatQuoteSelection";
import type { SelectionHighlight } from "../../../shared/schemas/selection";
import type { BookDetail } from "../../../shared/schemas/book";
import { bookKey } from "../../hooks/useBook";
import type { DeleteHighlight } from "../../hooks/useHighlights";
import type { SearchSelections } from "../../hooks/useHighlightSearch";
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
  readingState: null,
};

/** An answer already in the thread, for the reader to pick a passage out of. */
const ANSWER = "エッジではメモリを共有できないため、状態は Durable Objects に置きます。";

const ANSWER_MESSAGE = {
  id: "m1",
  role: "assistant" as const,
  content: ANSWER,
  createdAt: "2026-08-03T10:00:00.000Z",
};

function renderChat(
  options: {
    activeSelection?: ActiveSelection | null;
    /** Set to render the panel as it looks when the book itself failed to load. */
    bookError?: Error;
    /** Put in the thread before rendering, so a passage can be dragged over. */
    messages?: { id: string; role: "user" | "assistant"; content: string; createdAt: string }[];
    /** Stands in for the delete endpoint the list reaches for. */
    deleteHighlight?: DeleteHighlight;
    /** Stands in for the search endpoint, which looks through the chats too. */
    searchHighlights?: SearchSelections;
  } = {},
) {
  const {
    activeSelection = { id: "s1", selectedText: SELECTED_TEXT, pageNumber: 42 },
    bookError,
    messages = [],
    deleteHighlight,
    searchHighlights,
  } = options;
  const book = bookError ? undefined : BOOK;
  const store = createStore();
  store.set(activeSelectionAtom, activeSelection);
  store.set(chatMessagesAtom, messages);

  // Stands in for a drag over the thread: jsdom lays no text out and has no
  // Selection to read, so what a drag "selected" is set by the test.
  let selected: ChatQuoteSelection | null = null;

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
          readQuote={() => selected}
          deleteHighlight={deleteHighlight}
          searchHighlights={searchHighlights}
        />
      </Provider>
    </SwrTestCache>,
  );

  return {
    store,
    opened,
    /** Drags over a message of the thread and takes up the offer to quote it. */
    quote: async (text: string) => {
      selected = { text, rect: { top: 0, left: 0, width: 0 } };
      document.dispatchEvent(new Event("selectionchange"));
      await userEvent.click(await screen.findByRole("button", { name: "引用して質問" }));
    },
  };
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
    expect(calls.map((call) => [call.url, call.body])).toStrictEqual([
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

    expect(opened).toStrictEqual([{ id: "s2", selectedText: OTHER_TEXT, pageNumber: 7 }]);
  });

  it("narrows the list to what the server says holds the query, chats included", async () => {
    const asked: string[] = [];
    renderChat({
      activeSelection: null,
      // The chats are not in the book, so only the server can say that this
      // passage's conversation mentions it.
      searchHighlights: (_pdfId, query) => {
        asked.push(query);
        return Promise.resolve({ selectionIds: ["s2"] });
      },
    });

    await userEvent.type(screen.getByLabelText("ハイライトを検索"), "集約");
    // Typing alone asks nothing of the server; the button is what runs it.
    expect(asked).toStrictEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "検索" }));

    await waitFor(() => expect(screen.getByText("ハイライト 2件中 1件")).toBeInTheDocument());
    expect(screen.getByText(OTHER_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(SELECTED_TEXT)).toBeNull();
    expect(asked).toStrictEqual(["集約"]);
  });

  it("takes a deleted highlight out of the list the book shares with the viewer", async () => {
    const deleted: [string, string][] = [];
    renderChat({
      activeSelection: null,
      deleteHighlight: (pdfId, selectionId) => {
        deleted.push([pdfId, selectionId]);
        return okAsync({ deleted: true as const });
      },
    });

    await userEvent.click(screen.getByRole("button", { name: /^「エッジはサーバーレス実行基盤/ }));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(screen.getByText("ハイライト 1件")).toBeInTheDocument());
    expect(deleted).toStrictEqual([[BOOK.id, "s1"]]);
    expect(screen.getByText(OTHER_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(SELECTED_TEXT)).toBeNull();
  });

  it("leaves the chat a reader opened on a highlight while its deletion was in flight", async () => {
    // The gap between asking and being told is where this can happen: the list
    // is gone by then, so the answer has to look at the chat that is open now.
    let acceptDeletion: (() => void) | undefined;
    const { store } = renderChat({
      activeSelection: null,
      deleteHighlight: () =>
        ResultAsync.fromSafePromise(
          new Promise<{ deleted: true }>((resolve) => {
            acceptDeletion = () => resolve({ deleted: true });
          }),
        ),
    });

    await userEvent.click(screen.getByRole("button", { name: /^「エッジはサーバーレス実行基盤/ }));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));
    act(() => {
      store.set(activeSelectionAtom, { id: "s1", selectedText: SELECTED_TEXT, pageNumber: 42 });
    });
    expect(screen.getByPlaceholderText("質問を入力...")).toBeInTheDocument();

    await act(async () => {
      acceptDeletion!();
    });

    await waitFor(() => expect(store.get(activeSelectionAtom)).toBeNull());
    expect(screen.getByText("ハイライト 1件")).toBeInTheDocument();
  });

  it("returns to the highlight list when the chat is left", async () => {
    const { store } = renderChat();

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));

    expect(store.get(activeSelectionAtom)).toBeNull();
    expect(screen.getByText("ハイライト 2件")).toBeInTheDocument();
  });

  it("sends a passage quoted out of the thread above the question it prompted", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { quote } = renderChat({ messages: [ANSWER_MESSAGE] });

    await quote(ANSWER);
    await userEvent.type(
      screen.getByPlaceholderText("質問を入力..."),
      "Durable Objects とは何ですか",
    );
    await userEvent.keyboard("{Enter}");

    expect(calls.map((call) => [call.url, call.body])).toStrictEqual([
      [
        "/api/pdf/p1/selections/s1/chats",
        {
          content: `> ${ANSWER}\n\nDurable Objects とは何ですか`,
          useWebSearch: true,
        },
      ],
    ]);
    // The quote belonged to that one question; the next starts clean
    expect(screen.queryByRole("button", { name: "引用を取り消す" })).toBeNull();
  });

  it("asks about the highlight again once the quote is taken back", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    vi.stubGlobal("fetch", fetchFn);
    const { quote } = renderChat({ messages: [ANSWER_MESSAGE] });
    await quote(ANSWER);

    await userEvent.click(screen.getByRole("button", { name: "引用を取り消す" }));

    expect(screen.getByText(SELECTED_TEXT)).toBeVisible();
    await userEvent.type(screen.getByPlaceholderText("質問を入力..."), "もう少し詳しく");
    await userEvent.keyboard("{Enter}");
    expect(calls.map((call) => call.body)).toStrictEqual([
      { content: "もう少し詳しく", useWebSearch: true },
    ]);
  });

  it("drops a quote taken in one conversation when another one is opened", async () => {
    // The quote is a passage of this thread; carrying it into the next one
    // would attach it to a conversation it was never part of
    const { store, quote } = renderChat({ messages: [ANSWER_MESSAGE] });
    await quote(ANSWER);
    expect(screen.getByRole("button", { name: "引用を取り消す" })).toBeVisible();

    act(() => {
      store.set(activeSelectionAtom, { id: "s2", selectedText: OTHER_TEXT, pageNumber: 7 });
    });

    expect(screen.getByText(OTHER_TEXT)).toBeVisible();
    expect(screen.queryByRole("button", { name: "引用を取り消す" })).toBeNull();
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
