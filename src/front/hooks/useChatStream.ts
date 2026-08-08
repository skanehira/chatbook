import { useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  chatAbortControllerAtom,
  abortChatStreamAtom,
} from "../atoms/chatAtom";
import { createSseParser } from "../lib/sseParser";
import { ApiError } from "../lib/fetcher";
import type { ChatMessage } from "../../shared/schemas/chat";
import type { Citation } from "../../shared/schemas/citation";
import { chatSseEventSchema } from "../../shared/schemas/sse";

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

          for (const block of parse(decoder.decode(value, { stream: true }))) {
            // An event the schema does not recognise is skipped rather than
            // passed on: a citation of an unknown kind would reach the badge
            // that renders by `type`, and a malformed token would be appended
            // to the answer as it is.
            const parsed = chatSseEventSchema.safeParse(block);
            if (!parsed.success) continue;

            const event = parsed.data;
            switch (event.event) {
              case "token": {
                fullContent += event.data.content;
                setStreamingContent(fullContent);
                break;
              }
              case "citation": {
                citations.push(event.data);
                options.onCitation?.(event.data);
                break;
              }
              case "done": {
                messageId = event.data.messageId;
                break;
              }
              case "error": {
                // The stream carries its failures at HTTP 200, so the status
                // an error of this kind reports is the stream's own.
                streamError = new ApiError(event.data.message, event.data.code, response.status);
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
