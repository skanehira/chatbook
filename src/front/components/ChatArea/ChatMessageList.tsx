// oxlint-disable-next-line no-restricted-imports -- 新着メッセージとストリーム更新に追随して最下部へスクロールするために必要
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../shared/schemas/chat";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { useSettledSelection } from "../../hooks/useSettledSelection";
import {
  readChatQuoteFromWindow,
  type ChatQuoteSelection,
  type ReadChatQuote,
} from "../../lib/chatQuoteSelection";

/** Fractional scroll positions rarely land on the foot exactly. */
const AT_BOTTOM_EPSILON_PX = 4;

interface ChatMessageListProps {
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
  /** Takes the passage the reader picked out of the thread to ask about. */
  onQuote: (text: string) => void;
  /**
   * Reads what the drag selected. Injectable because a real one needs laid-out
   * text under a real Selection, and jsdom has neither; this is the seam the
   * offer and what it hands over are tested through.
   */
  readQuote?: ReadChatQuote;
}

export function ChatMessageList({
  messages,
  streamingContent,
  isStreaming,
  onQuote,
  readQuote = readChatQuoteFromWindow,
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [quotable, setQuotable] = useState<ChatQuoteSelection | null>(null);

  /**
   * Keeps the newest tokens in view, unless the reader has gone back up to read
   * the answer from the start — being pulled to the foot of it on every token
   * is what leaves them unable to.
   *
   * Re-arming comes after the scroll, so the commit that ends the stream (the
   * saved answer and `isStreaming` false arrive together) leaves a reader who
   * stayed mid-answer where they are, and the next answer is followed again.
   */
  useEffect(() => {
    if (followingRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    if (!isStreaming) {
      followingRef.current = true;
    }
  }, [messages, streamingContent, isStreaming]);

  /**
   * The offer follows whatever the reader has settled on, however they chose it.
   *
   * Read from the browser announcing the selection rather than from `mouseup`,
   * so a finger — which never lets a button go — can quote an answer too.
   *
   * A selection that came to nothing takes the offer away with it: left up, it
   * would quote a passage the reader has already deselected.
   */
  useSettledSelection(
    useCallback(() => {
      setQuotable(threadRef.current ? readQuote(threadRef.current) : null);
    }, [readQuote]),
  );

  /**
   * Reads off the reader's own scrolling whether to keep following.
   *
   * Direction is what separates the two hands on the thread: scrolling to the
   * foot only ever moves down, so the steps of a smooth scroll never read as
   * the reader leaving it. Going up is theirs alone.
   *
   * Only while an answer is being written, since that is the only thing that
   * would pull them away; reading back through a finished conversation must not
   * leave the next one opened part-way up.
   */
  const handleScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    const { scrollTop, scrollHeight, clientHeight } = thread;
    if (scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_EPSILON_PX) {
      followingRef.current = true;
    } else if (isStreaming && scrollTop < lastScrollTopRef.current) {
      followingRef.current = false;
    }
    lastScrollTopRef.current = scrollTop;
  };

  return (
    <div ref={threadRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} message={msg} />
      ))}

      {isStreaming && streamingContent && (
        <ChatMessageBubble
          // A fence arrives a token at a time, so for most of this answer's
          // life the markdown holds half of one
          streaming
          message={{
            role: "assistant",
            content: streamingContent,
          }}
        />
      )}

      {isStreaming && !streamingContent && (
        <div className="flex items-center gap-2 py-2" role="status">
          <div className="flex gap-1">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:0ms]" />
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:150ms]" />
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
          <span className="text-xs text-gray-500">考え中…</span>
        </div>
      )}

      <div ref={bottomRef} />

      {quotable !== null && (
        <button
          type="button"
          // Pressing a button clears the selection before the click lands, and
          // with it the passage this offer is about
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onQuote(quotable.text);
            setQuotable(null);
            // The passage is in the quote box now. Left selected, the browser
            // would treat a drag over it as a drag-and-drop of the text, so
            // the reader could not pick it out a second time.
            window.getSelection()?.removeAllRanges();
          }}
          // Placed against the viewport, so it stays over the passage no matter
          // how far the thread is scrolled
          style={{
            position: "fixed",
            top: quotable.rect.top,
            left: quotable.rect.left + quotable.rect.width / 2,
          }}
          className="z-20 -translate-x-1/2 -translate-y-full cursor-pointer rounded-md bg-gray-800 px-2 py-1 text-xs text-white shadow-lg hover:bg-gray-700"
        >
          引用して質問
        </button>
      )}
    </div>
  );
}
