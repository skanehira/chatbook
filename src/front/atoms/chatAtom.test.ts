import { describe, it, expect } from "vite-plus/test";
import { createStore } from "jotai";
import {
  abortChatStreamAtom,
  activeSelectionAtom,
  chatAbortControllerAtom,
  isStreamingAtom,
  selectionDeletedAtom,
  streamingContentAtom,
  type ActiveSelection,
} from "./chatAtom";

const OPEN_CHAT: ActiveSelection = {
  id: "01JOPEN",
  selectedText: "KV は結果整合です。",
  pageNumber: 42,
};

describe("abortChatStreamAtom", () => {
  it("stops the running answer and clears what it was drawing", () => {
    const store = createStore();
    const controller = new AbortController();
    store.set(chatAbortControllerAtom, controller);
    store.set(isStreamingAtom, true);
    store.set(streamingContentAtom, "Durable Objects は");

    store.set(abortChatStreamAtom);

    expect(controller.signal.aborted).toBe(true);
    expect(store.get(chatAbortControllerAtom)).toBeNull();
    expect(store.get(isStreamingAtom)).toBe(false);
    expect(store.get(streamingContentAtom)).toBe("");
  });

  it("leaves the chat untouched when the answer it stopped is already gone", () => {
    const store = createStore();
    const controller = new AbortController();
    store.set(chatAbortControllerAtom, controller);
    store.set(streamingContentAtom, "Durable Objects は");

    store.set(abortChatStreamAtom);
    expect(controller.signal.aborted).toBe(true);
    expect(store.get(streamingContentAtom)).toBe("");

    // What the chat shows next is no longer the stopped answer's to clear
    store.set(streamingContentAtom, "次の回答の書き出し");
    store.set(abortChatStreamAtom);

    expect(store.get(streamingContentAtom)).toBe("次の回答の書き出し");
  });
});

describe("selectionDeletedAtom", () => {
  it("leaves the chat of a highlight that has just been deleted", () => {
    const store = createStore();
    const controller = new AbortController();
    store.set(activeSelectionAtom, OPEN_CHAT);
    store.set(chatAbortControllerAtom, controller);
    store.set(isStreamingAtom, true);

    store.set(selectionDeletedAtom, OPEN_CHAT.id);

    expect(store.get(activeSelectionAtom)).toBeNull();
    expect(controller.signal.aborted).toBe(true);
    expect(store.get(isStreamingAtom)).toBe(false);
  });

  it("keeps the open chat when some other highlight was the one deleted", () => {
    const store = createStore();
    const controller = new AbortController();
    store.set(activeSelectionAtom, OPEN_CHAT);
    store.set(chatAbortControllerAtom, controller);
    store.set(isStreamingAtom, true);

    store.set(selectionDeletedAtom, "01JOTHER");

    expect(store.get(activeSelectionAtom)).toStrictEqual(OPEN_CHAT);
    expect(controller.signal.aborted).toBe(false);
    expect(store.get(isStreamingAtom)).toBe(true);

    // The same chat does leave once it is the one deleted, so what stood above
    // is the guard holding rather than the atom never doing anything.
    store.set(selectionDeletedAtom, OPEN_CHAT.id);

    expect(store.get(activeSelectionAtom)).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  });
});
