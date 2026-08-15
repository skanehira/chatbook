import { atom } from "jotai";
import type { ChatMessage } from "../../shared/schemas/chat";

/** The highlighted passage the current conversation is about. */
export interface ActiveSelection {
  id: string;
  selectedText: string;
  pageNumber: number;
}

export const activeSelectionAtom = atom<ActiveSelection | null>(null);

/**
 * Whether the panel on the right — the highlight list, or a chat — is showing.
 *
 * Away until the book says otherwise, the same way the outline starts
 * (`outlineOpenAtom`): `useReadingLocation` puts it up as soon as the book
 * arrives, unless the book was left with it folded away.
 */
export const chatPanelOpenAtom = atom<boolean>(false);

/** How far the chat is drawn up over the page on a screen with room for one column. */
export type ChatSheetState = "closed" | "half" | "full";

/**
 * The sheet's own state, kept apart from `chatPanelOpenAtom` and off the server.
 *
 * The panel and the sheet answer different questions. The panel says whether a
 * reader on a wide screen folded the conversation away, which is saved with the
 * book so a laptop reopens it that way. A phone always starts on the book —
 * there is no second pane to have left open — so beginning at `closed` is not a
 * state worth carrying between devices, and half versus full is a gesture
 * rather than a place to return to.
 */
export const chatSheetAtom = atom<ChatSheetState>("closed");

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

/**
 * Leave the chat of a highlight the server has just dropped.
 *
 * Written as an atom rather than a check inside whoever asked for the deletion,
 * because the reader can open a chat while the request is in flight: a handler
 * comparing the selection it captured when it rendered would be looking at a
 * chat that has since been replaced. Reading the store as the answer lands is
 * the only way to see which chat is open by then.
 *
 * Emptying `activeSelectionAtom` is also what takes `?selection=` out of the
 * address and off the reading position, since both follow this atom.
 */
export const selectionDeletedAtom = atom(null, (get, set, deletedId: string) => {
  if (get(activeSelectionAtom)?.id !== deletedId) return;

  set(abortChatStreamAtom);
  set(activeSelectionAtom, null);
});
