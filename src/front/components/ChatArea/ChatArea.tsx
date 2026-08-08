import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  activeSelectionAtom,
  chatErrorAtom,
  abortChatStreamAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { BookDetail } from "../../../shared/schemas/book";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { HighlightListPanel } from "./HighlightListPanel";
import { useWebSearchAtom } from "../../atoms/settingsAtom";
import { useChatStream } from "../../hooks/useChatStream";
import { useHighlights } from "../../hooks/useHighlights";

interface ChatAreaProps {
  /** The book being read, or nothing while it is still being read in. */
  book: BookDetail | undefined;
  /** Why the book could not be read, if it could not. */
  bookError?: Error;
  onSelectionClick: (selection: ActiveSelection) => void;
}

/** A failure worded for the reader, in the one place the panel shows them. */
function ChatErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
      {message}
    </p>
  );
}

export function ChatArea({ book, bookError, onSelectionClick }: ChatAreaProps) {
  const [activeSelection, setActiveSelection] = useAtom(activeSelectionAtom);
  const { highlights } = useHighlights(book?.id);
  const messages = useAtomValue(chatMessagesAtom);
  const streamingContent = useAtomValue(streamingContentAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const chatError = useAtomValue(chatErrorAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const { sendMessage } = useChatStream();

  const handleSend = async (content: string) => {
    if (!book || !activeSelection) return;
    await sendMessage(book.id, activeSelection.id, content, useWebSearch);
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

  if (!activeSelection) {
    return <HighlightListPanel highlights={highlights} onSelect={onSelectionClick} />;
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="px-2 py-2 border-b border-gray-200 shrink-0">
        <button
          type="button"
          onClick={() => {
            abortChatStream();
            setActiveSelection(null);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm text-blue-600 hover:bg-gray-50"
        >
          <span aria-hidden="true">←</span> 一覧に戻る
        </button>
      </div>
      <ChatMessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
      />
      {chatError !== null && <ChatErrorNotice message={chatError} />}
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        quotedText={activeSelection.selectedText}
      />
    </div>
  );
}
