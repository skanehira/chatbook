import { useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  activeSelectionAtom,
  chatErrorAtom,
  abortChatStreamAtom,
  selectionDeletedAtom,
  bookChatOpenAtom,
  chatScopeAtom,
  chatFaceAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { BookDetail } from "../../../shared/schemas/book";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { ChatScopeMenu } from "./ChatScopeMenu";
import { HighlightListPanel } from "./HighlightListPanel";
import { useWebSearchAtom } from "../../atoms/settingsAtom";
import { useChatStream } from "../../hooks/useChatStream";
import { useChapters } from "../../hooks/useChapters";
import { useHighlights, type DeleteHighlight } from "../../hooks/useHighlights";
import { useHighlightSearch, type SearchSelections } from "../../hooks/useHighlightSearch";
import { formatQuotedQuestion } from "../../lib/quotedQuestion";
import { scopeRanges } from "../../lib/chatScope";
import type { ReadChatQuote } from "../../lib/chatQuoteSelection";

interface ChatAreaProps {
  /** The book being read, or nothing while it is still being read in. */
  book: BookDetail | undefined;
  /** Why the book could not be read, if it could not. */
  bookError?: Error;
  onSelectionClick: (selection: ActiveSelection) => void;
  /** Opens the conversation about the book itself, which no highlight holds. */
  onOpenBookChat: () => void;
  /** Reads what a drag over the thread selected; injectable for tests. */
  readQuote?: ReadChatQuote;
  /** Removes a highlight; injectable so tests can record or refuse one. */
  deleteHighlight?: DeleteHighlight;
  /** Searches the highlights and their chats; injectable for the same reason. */
  searchHighlights?: SearchSelections;
}

/** A failure worded for the reader, in the one place the panel shows them. */
function ChatErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
      {message}
    </p>
  );
}

export function ChatArea({
  book,
  bookError,
  onSelectionClick,
  onOpenBookChat,
  readQuote,
  deleteHighlight,
  searchHighlights,
}: ChatAreaProps) {
  const [activeSelection, setActiveSelection] = useAtom(activeSelectionAtom);
  const setBookChatOpen = useSetAtom(bookChatOpenAtom);
  const [scope, setScope] = useAtom(chatScopeAtom);
  const { data: chapterList, error: chaptersError } = useChapters(book?.id);
  const face = useAtomValue(chatFaceAtom);
  const { highlights, removeHighlight } = useHighlights(book?.id, undefined, deleteHighlight);
  const { query, setQuery, submit, matchedIds, searchError } = useHighlightSearch(
    book?.id,
    searchHighlights,
  );
  const selectionDeleted = useSetAtom(selectionDeletedAtom);
  const messages = useAtomValue(chatMessagesAtom);
  const streamingContent = useAtomValue(streamingContentAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const chatError = useAtomValue(chatErrorAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const { sendMessage } = useChatStream();

  /** A passage of this thread the next question is about, if one was picked. */
  const [quote, setQuote] = useState<string | null>(null);

  // The highlight is the passage the question is about, and it is the reader's
  // to leave behind; the book's own conversation has none. Resolved here rather
  // than read off `activeSelection` below, so the branches agree with the face.
  const selection = face === "highlight" ? activeSelection : null;
  /** Which thread a quote was taken out of, for the reset below. */
  const thread = face === "book" ? "book" : (selection?.id ?? null);

  // A quote is a passage of the conversation it was taken from, so opening
  // another one leaves it behind. Adjusted during the render that brings the
  // new thread in, so the input never shows the old quote under it.
  const [quotedFrom, setQuotedFrom] = useState(thread);
  if (thread !== quotedFrom) {
    setQuotedFrom(thread);
    setQuote(null);
  }

  const handleSend = async (content: string) => {
    if (!book || face === "list") return;
    // The quote rides inside the message: the thread is stored as content and
    // nothing beside it would survive a reload or reach the model.
    const question = quote === null ? content : formatQuotedQuestion(quote, content);
    setQuote(null);

    if (selection !== null) {
      await sendMessage(book.id, selection.id, question, useWebSearch);
      return;
    }
    // The book's own conversation: no highlight under the question, and the
    // pages it is aimed at carried with it. A thread stays open across
    // turns, so the next question can be about another chapter.
    await sendMessage(book.id, null, question, useWebSearch, {
      scope: scopeRanges(scope, book.pageCount),
    });
  };

  const backToList = () => {
    abortChatStream();
    if (face === "book") setBookChatOpen(false);
    else setActiveSelection(null);
  };

  if (bookError && !book) {
    // The highlights are read out of the book, so a book that did not load has
    // no list to show — and an empty list here reads as "nothing marked yet".
    // A book already in hand still wins: a failed re-read of it changes nothing
    // about the highlights on screen.
    return (
      <div className="flex h-full flex-col justify-center bg-white">
        <ChatErrorNotice message={`ハイライトを読み込めませんでした: ${bookError.message}`} />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <p className="text-gray-400 text-sm">PDFを開いてテキストを選択してください</p>
      </div>
    );
  }

  if (face === "list") {
    return (
      <HighlightListPanel
        highlights={matchedIds ? highlights.filter((h) => matchedIds.has(h.id)) : highlights}
        total={highlights.length}
        query={query}
        onQueryChange={setQuery}
        onSearch={submit}
        searched={matchedIds !== null}
        searchError={searchError}
        onSelect={onSelectionClick}
        // Leaving the chat is the store's to decide once the server answers:
        // the reader can have opened one while the request was in flight.
        onDelete={(id) => removeHighlight(book.id, id).map(() => selectionDeleted(id))}
        onOpenBookChat={onOpenBookChat}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex items-center px-2 py-2 border-b border-gray-200 shrink-0">
        <button
          type="button"
          onClick={backToList}
          className="cursor-pointer rounded px-2 py-1 text-sm text-blue-600 hover:bg-gray-50"
        >
          <span aria-hidden="true">←</span> 一覧に戻る
        </button>
        {face === "book" && (
          <ChatScopeMenu
            chapters={chapterList?.chapters ?? []}
            chaptersError={chaptersError as Error | undefined}
            pageCount={book.pageCount}
            scope={scope}
            onChange={setScope}
          />
        )}
      </div>
      <ChatMessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        onQuote={setQuote}
        readQuote={readQuote}
      />
      {chatError !== null && <ChatErrorNotice message={chatError} />}
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        quotedText={selection === null ? quote : (quote ?? selection.selectedText)}
        onClearQuote={quote === null ? undefined : () => setQuote(null)}
      />
    </div>
  );
}
