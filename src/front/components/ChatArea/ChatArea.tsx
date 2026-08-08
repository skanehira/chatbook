import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  useWebSearchAtom,
  activeSelectionAtom,
  abortChatStreamAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { BookDetail } from "../../../shared/schemas/book";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { HighlightListPanel } from "./HighlightListPanel";
import { useChatStream } from "../../hooks/useChatStream";
import { useHighlights } from "../../hooks/useHighlights";

interface ChatAreaProps {
  /** The book being read, or nothing while it is still being read in. */
  book: BookDetail | undefined;
  onSelectionClick: (selection: ActiveSelection) => void;
}

export function ChatArea({ book, onSelectionClick }: ChatAreaProps) {
  const [activeSelection, setActiveSelection] = useAtom(activeSelectionAtom);
  const { highlights } = useHighlights(book?.id);
  const messages = useAtomValue(chatMessagesAtom);
  const streamingContent = useAtomValue(streamingContentAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const { sendMessage } = useChatStream();

  const handleSend = async (content: string) => {
    if (!book || !activeSelection) return;
    await sendMessage(book.id, activeSelection.id, content, useWebSearch);
  };

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
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        quotedText={activeSelection.selectedText}
      />
    </div>
  );
}
