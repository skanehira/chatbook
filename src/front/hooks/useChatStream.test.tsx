import { describe, it, expect } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { useChatStream } from "./useChatStream";
import {
  abortChatStreamAtom,
  chatAbortControllerAtom,
  chatMessagesAtom,
  isStreamingAtom,
  streamingContentAtom,
} from "../atoms/chatAtom";
import {
  citationEvent,
  doneEvent,
  errorEvent,
  streamingFetchStub,
  tokenEvent,
} from "../../test/streamingFetchStub";
import { ApiError } from "../lib/fetcher";
import type { Citation } from "../atoms/chatAtom";

const QUESTION = "Durable Objects とは?";

function renderChatStream(fetchFn: typeof fetch, now?: () => Date) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, view: renderHook(() => useChatStream(fetchFn, now), { wrapper }) };
}

describe("useChatStream", () => {
  it("adds the finished answer to the conversation and releases the stream", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);

    let sent!: Promise<void>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
    });
    await act(async () => {
      calls[0].emit(tokenEvent("単一の"));
      calls[0].emit(tokenEvent("インスタンスです"));
      calls[0].emit(doneEvent("m1"));
      calls[0].end();
      await sent;
    });

    expect(calls.map((call) => [call.url, call.body])).toEqual([
      ["/api/pdf/p1/selections/s1/chats", { content: QUESTION, useWebSearch: false }],
    ]);
    expect(store.get(chatMessagesAtom).map((m) => [m.role, m.content])).toEqual([
      ["user", QUESTION],
      ["assistant", "単一のインスタンスです"],
    ]);
    expect(store.get(streamingContentAtom)).toBe("");
    expect(store.get(isStreamingAtom)).toBe(false);
    expect(store.get(chatAbortControllerAtom)).toBeNull();
  });

  it("keeps a half-written answer out of the conversation when the chat is left", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);
    const errors: Error[] = [];

    let sent!: Promise<void>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false, {
        onError: (err) => errors.push(err),
      });
    });
    await act(async () => {
      calls[0].emit(tokenEvent("単一の"));
    });
    await waitFor(() => expect(store.get(streamingContentAtom)).toBe("単一の"));

    await act(async () => {
      store.set(abortChatStreamAtom);
      await sent;
    });

    expect(store.get(chatMessagesAtom).map((m) => [m.role, m.content])).toEqual([
      ["user", QUESTION],
    ]);
    expect(store.get(streamingContentAtom)).toBe("");
    expect(store.get(isStreamingAtom)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("drops the answer still streaming when the next question is asked", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);

    let firstSent!: Promise<void>;
    await act(async () => {
      firstSent = view.result.current.sendMessage("p1", "s1", "最初の質問", false);
    });
    await act(async () => {
      calls[0].emit(tokenEvent("途中まで"));
    });
    await waitFor(() => expect(store.get(streamingContentAtom)).toBe("途中まで"));

    let secondSent!: Promise<void>;
    await act(async () => {
      secondSent = view.result.current.sendMessage("p1", "s1", "次の質問", false);
    });
    await act(async () => {
      calls[1].emit(tokenEvent("こちらが答えです"));
      calls[1].emit(doneEvent("m2"));
      calls[1].end();
      await secondSent;
      await firstSent;
    });

    expect(store.get(chatMessagesAtom).map((m) => [m.role, m.content])).toEqual([
      ["user", "最初の質問"],
      ["user", "次の質問"],
      ["assistant", "こちらが答えです"],
    ]);
    expect(store.get(isStreamingAtom)).toBe(false);
    expect(store.get(chatAbortControllerAtom)).toBeNull();
  });

  it("keeps a citation of an unknown kind out of the answer's sources", async () => {
    // `data as Citation` used to hand this straight to CitationBadge, which
    // renders by `type`.
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);
    const received: Citation[] = [];

    let sent!: Promise<void>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false, {
        onCitation: (citation) => received.push(citation),
      });
    });
    await act(async () => {
      calls[0].emit(tokenEvent("単一のインスタンスです"));
      calls[0].emit(citationEvent({ id: "1", type: "podcast", text: "出所不明" }));
      calls[0].emit(
        citationEvent({ id: "2", type: "pdf", text: "エッジで動きます", pageNumber: 3 }),
      );
      calls[0].emit(doneEvent("m1"));
      calls[0].end();
      await sent;
    });

    const expected = [{ id: "2", type: "pdf", text: "エッジで動きます", pageNumber: 3 }];
    expect(received).toStrictEqual(expected);
    expect(store.get(chatMessagesAtom).at(-1)?.citations).toStrictEqual(expected);
  });

  it("reports the code as well as the message when the stream carries an error event", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { view } = renderChatStream(fetchFn);
    const errors: Error[] = [];

    let sent!: Promise<void>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false, {
        onError: (err) => errors.push(err),
      });
    });
    await act(async () => {
      calls[0].emit(errorEvent("AI_API_ERROR", "upstream is down"));
      calls[0].end();
      await sent;
    });

    expect(errors.map((err) => [err.message, (err as ApiError).code])).toStrictEqual([
      ["upstream is down", "AI_API_ERROR"],
    ]);
    expect(errors[0]).toBeInstanceOf(ApiError);
  });

  it("stamps both messages with the injected clock instead of the wall clock", async () => {
    const fixedNow = new Date("2026-01-02T03:04:05.678Z");
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn, () => fixedNow);

    let sent!: Promise<void>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
    });
    await act(async () => {
      calls[0].emit(tokenEvent("単一のインスタンスです"));
      calls[0].emit(doneEvent("m1"));
      calls[0].end();
      await sent;
    });

    expect(store.get(chatMessagesAtom)).toStrictEqual([
      {
        id: `temp-${fixedNow.getTime()}`,
        role: "user",
        content: QUESTION,
        createdAt: "2026-01-02T03:04:05.678Z",
      },
      {
        id: "m1",
        role: "assistant",
        content: "単一のインスタンスです",
        citations: [],
        createdAt: "2026-01-02T03:04:05.678Z",
      },
    ]);
  });
});
