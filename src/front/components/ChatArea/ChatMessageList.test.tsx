import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessageList } from "./ChatMessageList";
import { SELECTION_SETTLE_MS } from "../../hooks/useSettledSelection";
import type { ChatMessage } from "../../../shared/schemas/chat";
import type { ChatQuoteSelection } from "../../lib/chatQuoteSelection";

const question: ChatMessage = {
  id: "m1",
  role: "user",
  content: "この段落を一言で要約して",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const DRAGGED: ChatQuoteSelection = {
  text: "エッジはメモリを共有できません",
  rect: { top: 120, left: 40, width: 200 },
};

/**
 * The list with a stand-in for the drag.
 *
 * Reading the selection needs a real drag over laid-out text, and jsdom has
 * neither, so the read is the seam everything downstream is driven through.
 * The stand-in keeps what was last dragged over, like a browser holds a
 * selection until something replaces it.
 */
function renderList() {
  const onQuote = vi.fn();
  let selected: ChatQuoteSelection | null = null;
  const rendered = render(
    <ChatMessageList
      messages={[question]}
      streamingContent=""
      isStreaming={false}
      onQuote={onQuote}
      readQuote={() => selected}
    />,
  );
  return {
    ...rendered,
    onQuote,
    // However the passage was chosen, the list hears about it from the browser
    // announcing the selection
    drag: (passage: ChatQuoteSelection | null) => {
      selected = passage;
      document.dispatchEvent(new Event("selectionchange"));
    },
  };
}

describe("ChatMessageList", () => {
  // The document's selection outlives a test. jsdom's `addRange` is a no-op
  // while a range is already held, so a leftover would silently swallow the
  // arrange of whichever test sets one up next.
  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("shows the question and a waiting indicator while no token has arrived yet", () => {
    render(
      <ChatMessageList
        messages={[question]}
        streamingContent=""
        isStreaming={true}
        onQuote={vi.fn()}
      />,
    );

    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/^考え中…$/);
  });

  it("replaces the waiting indicator with the answer once tokens start arriving", () => {
    const { rerender } = render(
      <ChatMessageList
        messages={[question]}
        streamingContent=""
        isStreaming={true}
        onQuote={vi.fn()}
      />,
    );

    rerender(
      <ChatMessageList
        messages={[question]}
        streamingContent="要約すると"
        isStreaming={true}
        onQuote={vi.fn()}
      />,
    );

    expect(screen.getByText("要約すると")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The list tells the bubble that this answer is still being typed, and a
  // fence arriving a token at a time is not yet something to offer. This is the
  // other half of the bubble's own pair: drop the flag here and a reader is
  // handed a link to a document that is still being written.
  it("keeps an html fence in a streaming answer as the code it is written in", () => {
    const { container } = render(
      <ChatMessageList
        messages={[question]}
        streamingContent={"```html\n<div>A</div>\n```"}
        isStreaming={true}
        onQuote={vi.fn()}
      />,
    );

    expect(container.querySelector("pre")?.textContent).toBe("<div>A</div>\n");
    expect(screen.queryByRole("button", { name: "図解を見る" })).toBeNull();
  });

  it("shows only the finished conversation when nothing is streaming", () => {
    const answer: ChatMessage = {
      id: "m2",
      role: "assistant",
      content: "要約すると、これはテキスト選択の話です。",
      createdAt: "2026-01-01T00:00:01.000Z",
    };

    render(
      <ChatMessageList
        messages={[question, answer]}
        streamingContent=""
        isStreaming={false}
        onQuote={vi.fn()}
      />,
    );

    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.getByText("要約すると、これはテキスト選択の話です。")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  describe("following the answer as it streams", () => {
    // jsdom lays nothing out, so the thread has no height, no content taller
    // than itself, and nowhere to scroll. These stand in for all three.
    const THREAD_HEIGHT = 600;
    const THREAD_CONTENT_HEIGHT = 1000;
    const BOTTOM = THREAD_CONTENT_HEIGHT - THREAD_HEIGHT;
    const PART_WAY_UP = 120;
    /** What the foot can be short by on a screen that scrolls in fractions. */
    const A_FRACTION = 2;

    const answer: ChatMessage = {
      id: "m2",
      role: "assistant",
      content: "要約すると、これはテキスト選択の話です。",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const askedAgain: ChatMessage = {
      id: "m3",
      role: "user",
      content: "その理由は?",
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const anotherHighlight: ChatMessage = {
      id: "m4",
      role: "user",
      content: "この図の意味は?",
      createdAt: "2026-01-02T00:00:00.000Z",
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** The thread as the reader has it: scrollable, and waiting on an answer. */
    function renderThread() {
      const scrolledToBottom = vi.spyOn(Element.prototype, "scrollIntoView");
      const view = render(
        <ChatMessageList
          messages={[question]}
          streamingContent=""
          isStreaming={true}
          onQuote={vi.fn()}
        />,
      );
      const thread = view.container.firstElementChild as HTMLElement;
      // Anything wrapped above the thread would be given the geometry below
      // instead, and every test here would measure the wrong element in silence
      expect(thread).toHaveClass("overflow-y-auto");

      let scrollTop = BOTTOM;
      let contentHeight = THREAD_CONTENT_HEIGHT;
      Object.defineProperty(thread, "scrollHeight", {
        configurable: true,
        get: () => contentHeight,
      });
      Object.defineProperty(thread, "clientHeight", { configurable: true, value: THREAD_HEIGHT });
      Object.defineProperty(thread, "scrollTop", { configurable: true, get: () => scrollTop });

      const scrollTo = (to: number) => {
        scrollTop = to;
        fireEvent.scroll(thread);
      };
      // A browser reports the thread settling where the list scrolled it. jsdom
      // scrolls nothing, so the reader starts out at the foot by saying so.
      scrollTo(BOTTOM);

      const show = (messages: ChatMessage[], streamingContent: string, isStreaming: boolean) =>
        view.rerender(
          <ChatMessageList
            messages={messages}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
            onQuote={vi.fn()}
          />,
        );

      return {
        scrolledToBottom,
        thread,
        show,
        /** Another token lands on the answer being written. */
        token: (soFar: string) => show([question], soFar, true),
        /** The answer is saved and the stream ends, as one commit like the app does. */
        finish: () => show([question, answer], "", false),
        /** Whoever moved it — reader or list — the browser reports it the same way. */
        scrollTo,
        /** The answer being written makes the thread longer, moving its foot. */
        growContentBy: (px: number) => {
          contentHeight += px;
        },
      };
    }

    // Characterization of what the list already did: no RED, since keeping the
    // newest tokens in view is the behaviour the change carves an exception out
    // of. The same goes for the cases below that a reader can only reach once
    // following can stop; what each of them catches was settled by mutating the
    // list and watching it fail.
    it("keeps the newest tokens in view while the reader stays at the bottom", () => {
      const { token, thread, scrolledToBottom } = renderThread();
      scrolledToBottom.mockClear();

      token("要約すると");

      expect(scrolledToBottom.mock.calls).toStrictEqual([[{ behavior: "smooth" }]]);
      // The foot of the thread, and not the thread itself: scrolling the panel
      // into the page would look the same from the arguments alone
      expect(scrolledToBottom.mock.contexts).toHaveLength(1);
      expect(scrolledToBottom.mock.contexts[0]).toBe(thread.lastElementChild);
    });

    it.each([
      { where: "at the foot", stoppedAt: BOTTOM, keepsFollowing: true },
      {
        where: "a fraction short of the foot",
        stoppedAt: BOTTOM - A_FRACTION,
        keepsFollowing: true,
      },
      { where: "back up in the answer", stoppedAt: PART_WAY_UP, keepsFollowing: false },
    ])(
      "goes on following the answer for a reader who left the thread $where: $keepsFollowing",
      ({ stoppedAt, keepsFollowing }) => {
        const { token, scrollTo, scrolledToBottom } = renderThread();
        scrollTo(stoppedAt);
        scrolledToBottom.mockClear();

        token("要約すると、これは");

        expect(scrolledToBottom.mock.calls).toStrictEqual(
          keepsFollowing ? [[{ behavior: "smooth" }]] : [],
        );
        // The token arrived either way; it is the reader who stays put
        expect(screen.getByText("要約すると、これは")).toBeVisible();
      },
    );

    it("goes on following when its own scrolling steps the thread past the foot it knew", () => {
      // The answer makes the thread longer, so its foot moves away while the
      // list is scrolling towards it. Those steps arrive as plain scroll events:
      // only their direction tells them apart from the reader leaving.
      const { token, scrollTo, growContentBy, scrolledToBottom } = renderThread();
      growContentBy(400);
      scrollTo(BOTTOM + 150);
      scrollTo(BOTTOM + 300);
      scrolledToBottom.mockClear();

      token("要約すると、これは");

      expect(scrolledToBottom.mock.calls).toStrictEqual([[{ behavior: "smooth" }]]);
    });

    it("follows the answer again once the reader scrolls back to the bottom", () => {
      const { token, scrollTo, scrolledToBottom } = renderThread();
      scrollTo(PART_WAY_UP);
      token("要約すると");
      scrollTo(BOTTOM);
      scrolledToBottom.mockClear();

      token("要約すると、これは");

      expect(scrolledToBottom.mock.calls).toStrictEqual([[{ behavior: "smooth" }]]);
    });

    it("leaves the reader mid-answer when the answer they are reading finishes", () => {
      const { token, scrollTo, finish, scrolledToBottom } = renderThread();
      scrollTo(PART_WAY_UP);
      token("要約すると");
      scrolledToBottom.mockClear();

      finish();

      expect(scrolledToBottom.mock.calls).toStrictEqual([]);
      expect(screen.getByText(answer.content)).toBeVisible();
    });

    it("follows the next answer after leaving the reader mid-way through the last one", () => {
      const { token, scrollTo, finish, show, scrolledToBottom } = renderThread();
      scrollTo(PART_WAY_UP);
      token("要約すると");
      finish();
      scrolledToBottom.mockClear();

      show([question, answer, askedAgain], "", true);

      expect(scrolledToBottom.mock.calls).toStrictEqual([[{ behavior: "smooth" }]]);
    });

    it("still opens the next conversation at its foot after the reader scrolled up in a finished one", () => {
      // Reading back through an answer that is already written asks for nothing:
      // it is the answer being written that the reader would be dragged away from.
      // Swapping the conversation under the same list is what opening another
      // highlight comes to once its history lands.
      const { scrollTo, show, scrolledToBottom } = renderThread();
      show([question, answer], "", false);
      scrollTo(PART_WAY_UP);
      scrolledToBottom.mockClear();

      show([anotherHighlight], "", false);

      expect(scrolledToBottom.mock.calls).toStrictEqual([[{ behavior: "smooth" }]]);
    });
  });

  it("offers to quote a passage once it has been dragged over", async () => {
    const { drag } = renderList();

    drag(DRAGGED);

    expect(await screen.findByRole("button", { name: "引用して質問" })).toBeVisible();
  });

  it("hands the dragged passage over and puts the offer away when it is taken up", async () => {
    const { drag, onQuote } = renderList();
    drag(DRAGGED);

    await userEvent.click(await screen.findByRole("button", { name: "引用して質問" }));

    expect(onQuote.mock.calls).toStrictEqual([["エッジはメモリを共有できません"]]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "引用して質問" })).toBeNull());
  });

  it("lets go of the passage once it has been quoted", async () => {
    // A passage left selected is one the browser offers to drag and drop, so
    // the next drag over it moves text instead of selecting it — and the
    // reader cannot quote the same passage a second time.
    const { drag } = renderList();
    const marked = document.createRange();
    marked.selectNodeContents(screen.getByText(question.content));
    window.getSelection()!.addRange(marked);
    drag(DRAGGED);

    await userEvent.click(await screen.findByRole("button", { name: "引用して質問" }));

    expect(window.getSelection()?.toString()).toBe("");
  });

  it("puts the offer away when the next drag selected nothing to quote", async () => {
    // Otherwise the offer stays over a passage the reader has since deselected,
    // and quotes it
    const { drag } = renderList();
    drag(DRAGGED);
    expect(await screen.findByRole("button", { name: "引用して質問" })).toBeVisible();

    drag(null);

    await waitFor(() => expect(screen.queryByRole("button", { name: "引用して質問" })).toBeNull());
  });

  // Driven through the real read, so what the list hands it — the thread
  // element, not the whole document — is under test. With the stand-in above,
  // the list could read the page's text layer and nothing would notice.
  describe("reading the browser's own selection", () => {
    let outsideTheThread: HTMLParagraphElement;

    beforeEach(() => {
      // jsdom lays nothing out and leaves `Range` unmeasurable
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, left: 0, width: 0 }) as DOMRect,
      });
      outsideTheThread = document.createElement("p");
      outsideTheThread.textContent = "PDF 本文の一節";
      document.body.appendChild(outsideTheThread);
    });

    afterEach(() => {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
      outsideTheThread.remove();
    });

    /** The list wired to the real read, plus somewhere outside it to select. */
    function renderWithLiveSelection() {
      render(
        <ChatMessageList
          messages={[question]}
          streamingContent=""
          isStreaming={false}
          onQuote={vi.fn()}
        />,
      );

      return {
        select: (node: Node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          window.getSelection()!.addRange(range);
        },
        // The browser announces the selection either way; what differs is
        // where the text they had selected lives
        releaseOverThread: () => document.dispatchEvent(new Event("selectionchange")),
      };
    }

    it("offers to quote a passage selected in the thread", async () => {
      const { select, releaseOverThread } = renderWithLiveSelection();

      select(screen.getByText(question.content));
      releaseOverThread();

      expect(await screen.findByRole("button", { name: "引用して質問" })).toBeVisible();
    });

    it("ignores a passage still selected on the page outside the thread", async () => {
      // The reader drags over the PDF, then clicks in the chat panel: the
      // page's text is still selected, and it is not part of this conversation
      const { select, releaseOverThread } = renderWithLiveSelection();

      select(outsideTheThread);
      releaseOverThread();
      // Long enough that an offer that was going to appear has. Asserting
      // straight away would pass before the read is even due.
      await new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS + 80));

      // The thread is there to have made the offer in, and did not
      expect(screen.getByText(question.content)).toBeVisible();
      expect(screen.queryByRole("button", { name: "引用して質問" })).toBeNull();
    });
  });
});
