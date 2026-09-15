import type { Citation } from "../../shared/schemas/citation";
import type { ErrorCode, ErrorPayload } from "../../shared/schemas/error";
import { buildConversation, parseCitations } from "./chatService";
import {
  streamChatCompletion,
  streamResponseWithWebSearch,
  type LlmConfig,
  type StreamUsage,
} from "./llmService";

/**
 * Stores the finished answer and says which row it became, or null when it
 * could not be stored — an answer the reader has already been shown but that
 * will be gone the next time the conversation is opened.
 */
export type SaveAnswer = (
  answer: string,
  citations: Citation[],
  usage: StreamUsage,
) => Promise<{ messageId: string } | null>;

export interface ChatStreamRequest {
  llmConfig: LlmConfig & { webSearchSupported: boolean };
  systemPrompt: string;
  /** The turns before this question, oldest first. */
  history: { role: string; content: string }[];
  question: string;
  useWebSearch: boolean;
  /**
   * The stored full text a quoted passage is resolved to a page against. Not
   * the excerpt: a lookup inside the excerpt would call a chapter's second page
   * the book's second page.
   */
  fullText: string;
  pageCount: number;
  save: SaveAnswer;
  /** What keeps the save alive past the request the reader may walk away from. */
  waitUntil: (work: Promise<void>) => void;
}

/**
 * Answer a question over SSE, saving the answer before it is announced as
 * finished.
 *
 * Shared by the two conversations a book has — the one hanging off a highlight
 * and the one about the book itself — because everything after the prompt is
 * the same: the same events, the same save, the same way a failure to save is
 * told apart from a stream that broke off.
 *
 * Leaving the chat cancels the response body, which only means "stop sending":
 * the answer is still read to the end and saved, so reopening the conversation
 * shows it. Writing to a cancelled stream is allowed to throw, and a throw here
 * would escape into the AI service's own catch and lose the answer before it is
 * saved — swallowing it is what keeps the save reachable.
 */
export function streamChatReply(request: ChatStreamRequest): Response {
  const { llmConfig, systemPrompt, history, question, useWebSearch, fullText, pageCount } = request;
  const encoder = new TextEncoder();
  let fullResponse = "";
  let clientGone = false;
  let finished!: Promise<void>;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: string) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // A cancel can beat its own handler, so a refused write means the
          // client is gone too
          clientGone = true;
        }
      };
      const closeStream = () => {
        if (clientGone) return;
        try {
          controller.close();
        } catch {
          clientGone = true;
        }
      };

      const callbacks = {
        onToken(token: string) {
          fullResponse += token;
          send(`event: token\ndata: ${JSON.stringify({ content: token })}\n\n`);
        },
        async onDone(usage: StreamUsage) {
          const citations = parseCitations(fullResponse, fullText, pageCount);

          // Saved before the client is told, so a client that already left
          // cannot stop the save
          const stored = await request.save(fullResponse, citations, usage);

          // An answer that was not stored is gone the moment the conversation is
          // reopened. Sending `done` for it would show the reader a finished
          // conversation that empties itself on the next visit.
          if (stored === null) {
            send(
              `event: error\ndata: ${JSON.stringify({
                code: "CHAT_SAVE_FAILED" satisfies ErrorCode,
                message: "The answer could not be saved",
              } satisfies ErrorPayload)}\n\n`,
            );
            closeStream();
            return;
          }

          for (const citation of citations) {
            send(`event: citation\ndata: ${JSON.stringify(citation)}\n\n`);
          }
          send(`event: done\ndata: ${JSON.stringify({ messageId: stored.messageId, usage })}\n\n`);
          closeStream();
        },
        onError(err: Error) {
          send(
            `event: error\ndata: ${JSON.stringify({
              code: "AI_API_ERROR" satisfies ErrorCode,
              message: err.message,
            } satisfies ErrorPayload)}\n\n`,
          );
          closeStream();
        },
      };

      finished = (async () => {
        try {
          // Both endpoints get the same conversation; they differ only in where
          // the system prompt rides (`instructions` vs a turn)
          const conversation = buildConversation(
            history.map((turn) => ({ role: turn.role, content: turn.content })),
            question,
          );
          if (useWebSearch) {
            await streamResponseWithWebSearch(llmConfig, systemPrompt, conversation, callbacks);
          } else {
            await streamChatCompletion(
              llmConfig,
              [{ role: "system", content: systemPrompt }, ...conversation],
              callbacks,
            );
          }
        } catch (err) {
          send(
            `event: error\ndata: ${JSON.stringify({
              code: "AI_STREAM_ERROR" satisfies ErrorCode,
              message: String(err),
            } satisfies ErrorPayload)}\n\n`,
          );
          closeStream();
        }
      })();
    },
    cancel() {
      clientGone = true;
    },
  });

  request.waitUntil(finished);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
