// oxlint-disable-next-line no-restricted-imports -- 新着メッセージとストリーム更新に追随して最下部へスクロールするために必要
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../../shared/schemas/chat";
import { ChatMessageBubble } from "./ChatMessageBubble";

interface ChatMessageListProps {
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
}

export function ChatMessageList({ messages, streamingContent, isStreaming }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} message={msg} />
      ))}

      {isStreaming && streamingContent && (
        <ChatMessageBubble
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
    </div>
  );
}
