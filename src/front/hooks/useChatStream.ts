import { useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { ResultAsync, err, ok, type Result } from "neverthrow";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  chatAbortControllerAtom,
  chatErrorAtom,
  abortChatStreamAtom,
} from "../atoms/chatAtom";
import { createSseParser } from "../lib/sseParser";
import { ApiError, networkFailure } from "../lib/fetcher";
import type { ChatMessage } from "../../shared/schemas/chat";
import type { Citation } from "../../shared/schemas/citation";
import { errorEnvelopeSchema } from "../../shared/schemas/error";
import { chatSseEventSchema } from "../../shared/schemas/sse";

interface ChatStreamOptions {
  onCitation?: (citation: Citation) => void;
  onDone?: (messageId: string) => void;
}

/** How a failure of this conversation is worded for the reader. */
export const chatFailureMessage = (failure: ApiError) =>
  `回答の取得に失敗しました: ${failure.message}`;

/**
 * Default clock. Kept at module level so its identity is stable across
 * renders and `sendMessage` is not rebuilt on every render.
 */
const systemNow = () => new Date();

/** The refusal the server described, or the status when it described nothing. */
async function refusal(url: string, response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const envelope = errorEnvelopeSchema.safeParse(body);
  return envelope.success
    ? new ApiError(envelope.data.error.message, envelope.data.error.code, response.status)
    : new ApiError(
        `request to ${url} failed with status ${response.status}`,
        "UNKNOWN",
        response.status,
      );
}

/**
 * Send a question and render the answer as it streams in.
 *
 * `sendMessage` hands back the id of the stored answer, or the reason there is
 * none. The same reason is put in `chatErrorAtom`, which is what the panel
 * shows: the return value is for a caller that has its own decision to make
 * (the viewer keeps its popover open when the ask never got anywhere), not for
 * getting the failure on screen.
 */
export function useChatStream(fetchFn: typeof fetch = fetch, now: () => Date = systemNow) {
  const [, setMessages] = useAtom(chatMessagesAtom);
  const [, setStreamingContent] = useAtom(streamingContentAtom);
  const [, setIsStreaming] = useAtom(isStreamingAtom);
  const [, setAbortController] = useAtom(chatAbortControllerAtom);
  const [, setChatError] = useAtom(chatErrorAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const sendMessage = useCallback(
    (
      pdfId: string,
      selectionId: string,
      content: string,
      useWebSearch: boolean,
      options: ChatStreamOptions = {},
    ): ResultAsync<string, ApiError> => {
      const url = `/api/pdf/${pdfId}/selections/${selectionId}/chats`;

      const run = async (): Promise<Result<string, ApiError>> => {
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
        // Whatever went wrong last time is about the question before this one
        setChatError(null);

        const controller = new AbortController();
        setAbortController(controller);
        let aborted = false;

        try {
          const response = await fetchFn(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, useWebSearch }),
            signal: controller.signal,
          });

          if (!response.ok) throw await refusal(url, response);

          const reader = response.body?.getReader();
          if (!reader) {
            throw new ApiError(
              `response to ${url} carried no body to read`,
              "INVALID_RESPONSE",
              response.status,
              "parse",
            );
          }

          const decoder = new TextDecoder();
          const parse = createSseParser();
          let fullContent = "";
          const citations: Citation[] = [];
          let messageId = "";
          let streamError: ApiError | null = null;

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
          return ok(messageId);
        } catch (cause) {
          const failure = cause instanceof ApiError ? cause : networkFailure(url, cause);

          // Leaving the chat delivered no answer either, but the reader asked
          // for that: the atom the panel reads stays clear, and only a caller
          // that inspects the result can tell it apart.
          if (failure.code === "ABORTED") {
            aborted = true;
            return err(failure);
          }

          setStreamingContent("");
          setChatError(chatFailureMessage(failure));
          return err(failure);
        } finally {
          if (!aborted) {
            setIsStreaming(false);
            // Only clear the stream this call owns; a newer one may have taken over
            setAbortController((current) => (current === controller ? null : current));
          }
        }
      };

      return new ResultAsync(run());
    },
    [
      abortChatStream,
      fetchFn,
      now,
      setMessages,
      setStreamingContent,
      setIsStreaming,
      setAbortController,
      setChatError,
    ],
  );

  return { sendMessage };
}
