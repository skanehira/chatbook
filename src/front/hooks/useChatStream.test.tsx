import { describe, it, expect } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import type { ResultAsync } from "neverthrow";
import { useChatStream } from "./useChatStream";
import {
  abortChatStreamAtom,
  chatAbortControllerAtom,
  chatErrorAtom,
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
import type { Citation } from "../../shared/schemas/citation";

const QUESTION = "Durable Objects とは?";

/** The four facts a caller reads off a failure, in one comparable value. */
function failureOf(error: ApiError): [string, string, number, string] {
  return [error.message, error.code, error.status, error.kind];
}

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

    let sent!: ResultAsync<string, ApiError>;
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

    let sent!: ResultAsync<string, ApiError>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
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
    // Nothing was delivered, so the send failed — but the reader asked for that
    // and must not be shown an error for it.
    expect(failureOf((await sent)._unsafeUnwrapErr())).toStrictEqual([
      "The operation was aborted.",
      "ABORTED",
      0,
      "network",
    ]);
    expect(store.get(chatErrorAtom)).toBeNull();
  });

  it("drops the answer still streaming when the next question is asked", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);

    let firstSent!: ResultAsync<string, ApiError>;
    await act(async () => {
      firstSent = view.result.current.sendMessage("p1", "s1", "最初の質問", false);
    });
    await act(async () => {
      calls[0].emit(tokenEvent("途中まで"));
    });
    await waitFor(() => expect(store.get(streamingContentAtom)).toBe("途中まで"));

    let secondSent!: ResultAsync<string, ApiError>;
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

    let sent!: ResultAsync<string, ApiError>;
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
    const { store, view } = renderChatStream(fetchFn);

    let sent!: ResultAsync<string, ApiError>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
    });
    await act(async () => {
      calls[0].emit(errorEvent("AI_API_ERROR", "upstream is down"));
      calls[0].end();
      await sent;
    });

    expect(failureOf((await sent)._unsafeUnwrapErr())).toStrictEqual([
      "upstream is down",
      "AI_API_ERROR",
      200,
      "http",
    ]);
    expect(store.get(chatErrorAtom)).toBe("回答の取得に失敗しました: upstream is down");
  });

  it("keeps the server's own words when the request is refused before the stream starts", async () => {
    // The refusal used to become "HTTP 400", which threw away the one thing
    // that says what to change about the question.
    const refusing: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "VALIDATION_ERROR", message: "Invalid request body: content" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      );
    const { store, view } = renderChatStream(refusing);

    let sent!: ResultAsync<string, ApiError>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
      await sent;
    });

    expect(failureOf((await sent)._unsafeUnwrapErr())).toStrictEqual([
      "Invalid request body: content",
      "VALIDATION_ERROR",
      400,
      "http",
    ]);
    expect(store.get(chatErrorAtom)).toBe(
      "回答の取得に失敗しました: Invalid request body: content",
    );
  });

  it("reports a request that never reached the server instead of leaving the panel silent", async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const { store, view } = renderChatStream(offline);

    let sent!: ResultAsync<string, ApiError>;
    await act(async () => {
      sent = view.result.current.sendMessage("p1", "s1", QUESTION, false);
      await sent;
    });

    expect(failureOf((await sent)._unsafeUnwrapErr())).toStrictEqual([
      "request to /api/pdf/p1/selections/s1/chats could not be sent",
      "NETWORK_ERROR",
      0,
      "network",
    ]);
    expect(store.get(chatErrorAtom)).toBe(
      "回答の取得に失敗しました: request to /api/pdf/p1/selections/s1/chats could not be sent",
    );
    expect(store.get(isStreamingAtom)).toBe(false);
  });

  it("drops the previous failure when the next question is asked", async () => {
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn);

    let failed!: ResultAsync<string, ApiError>;
    await act(async () => {
      failed = view.result.current.sendMessage("p1", "s1", QUESTION, false);
    });
    await act(async () => {
      calls[0].emit(errorEvent("AI_API_ERROR", "upstream is down"));
      calls[0].end();
      await failed;
    });
    expect(store.get(chatErrorAtom)).toBe("回答の取得に失敗しました: upstream is down");

    let retried!: ResultAsync<string, ApiError>;
    await act(async () => {
      retried = view.result.current.sendMessage("p1", "s1", "もう一度", false);
    });
    await act(async () => {
      calls[1].emit(tokenEvent("単一のインスタンスです"));
      calls[1].emit(doneEvent("m2"));
      calls[1].end();
      await retried;
    });

    expect((await retried)._unsafeUnwrap()).toBe("m2");
    expect(store.get(chatErrorAtom)).toBeNull();
  });

  it("stamps both messages with the injected clock instead of the wall clock", async () => {
    const fixedNow = new Date("2026-01-02T03:04:05.678Z");
    const { fetchFn, calls } = streamingFetchStub();
    const { store, view } = renderChatStream(fetchFn, () => fixedNow);

    let sent!: ResultAsync<string, ApiError>;
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
