import { atom } from "jotai";
import type { ChatMessage } from "../../shared/schemas/chat";

/** The highlighted passage the current conversation is about. */
export interface ActiveSelection {
  id: string;
  selectedText: string;
  pageNumber: number;
}

export const activeSelectionAtom = atom<ActiveSelection | null>(null);
export const chatMessagesAtom = atom<ChatMessage[]>([]);
export const streamingContentAtom = atom<string>("");
export const isStreamingAtom = atom<boolean>(false);

/**
 * What went wrong with this conversation, worded for the reader, or null when
 * nothing has.
 *
 * The panel reads this and nothing else: `sendMessage` also hands its failure
 * back so a caller can decide what to do next, but a caller that ignores the
 * return value still cannot leave the reader staring at an unanswered
 * question. Whoever writes here words the message, since "the answer never
 * came" and "the history could not be read" are not the same sentence.
 */
export const chatErrorAtom = atom<string | null>(null);

/** Shared, so leaving a chat can stop an answer any of the panels started. */
export const chatAbortControllerAtom = atom<AbortController | null>(null);

/**
 * Stop the answer being streamed and put the chat back at rest.
 *
 * The tidy-up lives here rather than in the stream's own cleanup so that
 * starting the next answer straight after cannot be undone by the old one
 * finishing a moment later.
 */
export const abortChatStreamAtom = atom(null, (get, set) => {
  const controller = get(chatAbortControllerAtom);
  if (!controller) return;

  controller.abort();
  set(chatAbortControllerAtom, null);
  set(isStreamingAtom, false);
  set(streamingContentAtom, "");
});
