import { atom } from "jotai";
import type { ChatMessage } from "../../shared/schemas/chat";
import type { SelectionHighlight } from "../../shared/schemas/selection";

export type { ChatMessage } from "../../shared/schemas/chat";
export type { Citation } from "../../shared/schemas/citation";
export type { SelectionHighlight } from "../../shared/schemas/selection";

/** The highlighted passage the current conversation is about. */
export interface ActiveSelection {
  id: string;
  selectedText: string;
  pageNumber: number;
}

export const activeSelectionAtom = atom<ActiveSelection | null>(null);
// Shared so the chat panel can list the same highlights the viewer draws.
export const selectionsAtom = atom<SelectionHighlight[]>([]);
export const chatMessagesAtom = atom<ChatMessage[]>([]);
export const streamingContentAtom = atom<string>("");
export const isStreamingAtom = atom<boolean>(false);
// Web search is on by default: the assistant should fall back to the web when
// the document alone cannot answer the question.
export const useWebSearchAtom = atom<boolean>(true);

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
