import { useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  chatAbortControllerAtom,
  abortChatStreamAtom,
  type ChatMessage,
  type Citation,
} from "../atoms/chatAtom";
import { createSseParser } from "../lib/sseParser";

/** fetch reports an abort with a DOMException, which does not extend Error. */
function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

interface ChatStreamOptions {
  onCitation?: (citation: Citation) => void;
  onDone?: (messageId: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Default clock. Kept at module level so its identity is stable across
 * renders and `sendMessage` is not rebuilt on every render.
 */
const systemNow = () => new Date();

/**
 * Send a question and render the answer as it streams in.
 */
export function useChatStream(fetchFn: typeof fetch = fetch, now: () => Date = systemNow) {
  const [, setMessages] = useAtom(chatMessagesAtom);
  const [, setStreamingContent] = useAtom(streamingContentAtom);
  const [, setIsStreaming] = useAtom(isStreamingAtom);
  const [, setAbortController] = useAtom(chatAbortControllerAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const sendMessage = useCallback(
    async (
      pdfId: string,
      selectionId: string,
      content: string,
      useWebSearch: boolean,
      options: ChatStreamOptions = {},
    ) => {
      // Only one answer streams at a time, so asking again never leaves an
      // older one writing into this conversation
      abortChatStream();

      // Show the question straight away, before the model has answered
      const userMsg: ChatMessage = {
        id: `temp-${now().getTime()}`,
        role: "user",
        content,
        createdAt: now().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreamingContent("");
      setIsStreaming(true);

      const controller = new AbortController();
      setAbortController(controller);
      let aborted = false;

      try {
        const response = await fetchFn(`/api/pdf/${pdfId}/selections/${selectionId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, useWebSearch }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        const parse = createSseParser();
        let fullContent = "";
        const citations: Citation[] = [];
        let messageId = "";
        let streamError: Error | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          for (const { event, data } of parse(decoder.decode(value, { stream: true }))) {
            switch (event) {
              case "token": {
                const { content: token } = data as { content?: string };
                if (token) {
                  fullContent += token;
                  setStreamingContent(fullContent);
                }
                break;
              }
              case "citation": {
                const citation = data as Citation;
                citations.push(citation);
                options.onCitation?.(citation);
                break;
              }
              case "done": {
                messageId = (data as { messageId?: string }).messageId ?? "";
                break;
              }
              case "error": {
                streamError = new Error((data as { message?: string }).message ?? "stream error");
                break;
              }
            }
          }
        }

        if (streamError) throw streamError;

        setMessages((prev) => [
          ...prev,
          {
            id: messageId || `temp-${now().getTime()}`,
            role: "assistant",
            content: fullContent,
            citations,
            createdAt: now().toISOString(),
          },
        ]);
        setStreamingContent("");
        options.onDone?.(messageId);
      } catch (err) {
        // Leaving the chat is not a failure to report, and the atom that
        // aborted has already put the panel back at rest
        if (isAbortError(err)) {
          aborted = true;
          return;
        }
        setStreamingContent("");
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!aborted) {
          setIsStreaming(false);
          // Only clear the stream this call owns; a newer one may have taken over
          setAbortController((current) => (current === controller ? null : current));
        }
      }
    },
    [
      abortChatStream,
      fetchFn,
      now,
      setMessages,
      setStreamingContent,
      setIsStreaming,
      setAbortController,
    ],
  );

  return { sendMessage };
}
