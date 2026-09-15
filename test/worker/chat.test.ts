import { describe, it, expect, beforeAll } from "vite-plus/test";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { apiFetch } from "./setup/session";
import app from "../../src/server/index";
import { SESSION_COOKIE, issueSession } from "../../src/server/auth/session";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { MINIMAL_PDF_BYTES } from "./fixtures/minimalPdf";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * The provider these tests point the Worker at, from the bindings in
 * `vitest.workers.config.ts`. Not DeepSeek's own host, so a request that
 * ignored `LLM_BASE_URL` would miss every handler below rather than pass on
 * the built-in default.
 */
const LLM_BASE = "https://llm.test";
const LLM_MODEL = "test-model";
const LLM_KEY = "test-key";

/** The book's text. The highlighted passage is deliberately absent from it, so
 * a prompt that drops the selection cannot pass by quoting the book instead. */
const BOOK_TEXT = "Workers run on Cloudflare's global network.";
const HIGHLIGHTED_PASSAGE = "Durable Objects";

/** What a test can vary about the book its chat hangs off. */
interface SelectionOptions {
  fullText?: string;
  pageCount?: number;
  outline?: { title: string; pageNumber: number }[];
  selectionPage?: number;
}

/**
 * A book plus a highlighted passage, which is what a chat hangs off.
 *
 * Books are de-duplicated by content hash and D1 is only isolated per test
 * file, so each test appends its own PDF comment to get a book of its own.
 */
async function createSelection(
  tag: string,
  options: SelectionOptions = {},
): Promise<{ pdfId: string; selectionId: string }> {
  const suffix = new TextEncoder().encode(`\n%${tag}\n`);
  const bytes = new Uint8Array(MINIMAL_PDF_BYTES.length + suffix.length);
  bytes.set(MINIMAL_PDF_BYTES, 0);
  bytes.set(suffix, MINIMAL_PDF_BYTES.length);

  const formData = new FormData();
  formData.append("file", new File([bytes], `${tag}.pdf`, { type: "application/pdf" }));
  formData.append("fullText", options.fullText ?? BOOK_TEXT);
  formData.append("pageCount", String(options.pageCount ?? 1));
  if (options.outline) formData.append("outline", JSON.stringify(options.outline));

  const uploadResponse = await apiFetch("https://example.com/api/pdf/open", {
    method: "POST",
    body: formData,
  });
  const { id: pdfId } = (await uploadResponse.json()) as { id: string };

  const selectionResponse = await apiFetch(`https://example.com/api/pdf/${pdfId}/selections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedText: HIGHLIGHTED_PASSAGE,
      pageNumber: options.selectionPage ?? 1,
      positionData: { rects: [] },
    }),
  });
  const { id: selectionId } = (await selectionResponse.json()) as { id: string };

  return { pdfId, selectionId };
}

/** One token chunk of the chat completions stream. */
function chatCompletionsToken(token: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
}

/**
 * What closes a chat completions stream: the usage chunk, then [DONE].
 *
 * `prompt_cache_hit_tokens` is DeepSeek's own field — the OpenAI SDK does not
 * know it, but it is the only way to see how much of the book was reused.
 */
function chatCompletionsTail(cacheHitTokens: number | null = 9): string {
  const usage = JSON.stringify({
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 2,
      // Left out entirely when the upstream reports no cache figure at all
      ...(cacheHitTokens === null ? {} : { prompt_cache_hit_tokens: cacheHitTokens }),
    },
  });
  return `data: ${usage}\n\ndata: [DONE]\n\n`;
}

/** An SSE body shaped like the chat completions stream, ending in [DONE]. */
function chatCompletionsSse(tokens: string[], cacheHitTokens: number | null = 9): string {
  return tokens.map(chatCompletionsToken).join("") + chatCompletionsTail(cacheHitTokens);
}

/** An SSE body shaped like the responses API stream used for web search. */
function responsesSse(tokens: string[]): string {
  const chunks = tokens.map(
    (token) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: token })}`,
  );
  chunks.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 11, output_tokens: 2 } },
    })}`,
  );
  return `${chunks.join("\n\n")}\n\n`;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse the endpoint's SSE response into the events a client would see. */
function parseSse(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "";
      const data = block.match(/^data: (.+)$/m)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/** The passage the system prompt hands the model as the user's highlight. */
function highlightedPassageIn(instructions: string): string | undefined {
  return instructions.match(
    /--- HIGHLIGHTED PASSAGE ---\n([\s\S]*?)\n--- END HIGHLIGHTED PASSAGE ---/,
  )?.[1];
}

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  citations: unknown;
  createdAt: string;
}

/**
 * The conversation as it was saved, which is what a reopened chat shows.
 *
 * The status is asserted here so that a conversation which fails to load shows
 * up as "expected 500 to be 200" rather than as a JSON parse error on the
 * words "Internal Server Error".
 */
async function readChatHistory(pdfId: string, selectionId: string): Promise<StoredMessage[]> {
  const response = await apiFetch(
    `https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`,
  );
  expect(response.status).toBe(200);
  const { messages } = (await response.json()) as { messages: StoredMessage[] };
  return messages;
}

async function postChat(pdfId: string, selectionId: string, payload: unknown): Promise<Response> {
  return apiFetch(`https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * An earlier round written straight into D1, newest row first.
 *
 * The store hands rows back in the order they were inserted unless the query
 * says otherwise, so writing the answer before the question it answers is what
 * tells a chronological read apart from one that happens to agree with it.
 */
async function seedTurnsWrittenOutOfOrder(
  selectionId: string,
): Promise<{ questionId: string; answerId: string }> {
  // D1 is shared by the whole file, so the ids are hung off the selection
  const questionId = `${selectionId}-turn-1`;
  const answerId = `${selectionId}-turn-2`;
  const turns = [
    {
      id: answerId,
      role: "assistant",
      content: "They keep state on one thread.",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      id: questionId,
      role: "user",
      content: "What are Durable Objects?",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  for (const turn of turns) {
    // The book is taken from the highlight the row hangs off, so the seed needs
    // no book of its own to name
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, selection_id, pdf_id, role, content, created_at)
       SELECT ?, ?, pdf_id, ?, ?, ? FROM selections WHERE id = ?`,
    )
      .bind(turn.id, selectionId, turn.role, turn.content, turn.createdAt, selectionId)
      .run();
  }

  return { questionId, answerId };
}

/** What an answer cost, as it can be read back out of D1 for a cost report. */
async function readTokenCounts(selectionId: string) {
  return env.DB.prepare(
    "SELECT input_tokens, output_tokens, cached_input_tokens FROM chat_messages WHERE selection_id = ? AND role = 'assistant'",
  )
    .bind(selectionId)
    .first();
}

describe("POST /api/pdf/:pdfId/selections/:selId/chats", () => {
  it("streams tokens from the chat completions endpoint as SSE when web search is off", async () => {
    const { pdfId, selectionId } = await createSelection("chat-stream");
    const calledUrls: string[] = [];

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, ({ request }) => {
        calledUrls.push(request.url);
        return new HttpResponse(chatCompletionsSse(["Durable ", "Objects"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    // The upstream handler only runs to completion once the SSE stream is
    // drained, so read the body before asserting on what it captured.
    const events = parseSse(await response.text());

    expect(calledUrls).toStrictEqual([`${LLM_BASE}/chat/completions`]);
    expect(events.map((e) => e.event)).toStrictEqual(["token", "token", "done"]);
    expect(events.slice(0, 2).map((e) => e.data)).toStrictEqual([
      { content: "Durable " },
      { content: "Objects" },
    ]);
    expect(events[2].data).toStrictEqual({
      messageId: expect.any(String),
      usage: { inputTokens: 11, outputTokens: 2, cachedInputTokens: 9 },
    });
  });

  it("stores what the answer cost alongside it, so the cache hit can be counted later", async () => {
    const { pdfId, selectionId } = await createSelection("chat-token-counts");

    server.use(
      http.post(
        `${LLM_BASE}/chat/completions`,
        () =>
          new HttpResponse(chatCompletionsSse(["Durable ", "Objects"]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });
    // Draining the stream is what runs the save
    await response.text();

    expect(await readTokenCounts(selectionId)).toStrictEqual({
      input_tokens: 11,
      output_tokens: 2,
      cached_input_tokens: 9,
    });
  });

  it("sends the highlighted passage as context and asks for web search when it is on", async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch");
    let requestBody: Record<string, unknown> = {};
    let sentAuthorization: string | null = null;

    server.use(
      http.post(`${LLM_BASE}/responses`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        sentAuthorization = request.headers.get("Authorization");
        return new HttpResponse(responsesSse(["Workers ", "run everywhere"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "Where do Workers run?",
      useWebSearch: true,
    });

    expect(response.status).toBe(200);

    const events = parseSse(await response.text());

    // This path builds its request by hand rather than through the OpenAI SDK,
    // so the model and the key are carried separately from the other endpoint's
    expect(requestBody.model).toBe(LLM_MODEL);
    expect(sentAuthorization).toBe(`Bearer ${LLM_KEY}`);
    expect(requestBody.tools).toStrictEqual([{ type: "web_search" }]);
    expect(requestBody.input).toStrictEqual([
      { type: "message", role: "user", content: "Where do Workers run?" },
    ]);
    expect(highlightedPassageIn(String(requestBody.instructions))).toBe(HIGHLIGHTED_PASSAGE);

    expect(events.map((e) => e.event)).toStrictEqual(["token", "token", "done"]);
    expect(events.slice(0, 2).map((e) => e.data)).toStrictEqual([
      { content: "Workers " },
      { content: "run everywhere" },
    ]);
  });

  it("saves the answer even when the reader leaves the chat mid-stream", async () => {
    const { pdfId, selectionId } = await createSelection("chat-disconnect");
    const encoder = new TextEncoder();

    // Hold the rest of the answer back until the client is gone, so the tokens
    // that decide whether the save survives really do arrive after the cut.
    let deliverRest!: () => void;
    const rest = new Promise<void>((resolve) => {
      deliverRest = resolve;
    });

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, () => {
        const body = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(chatCompletionsToken("Durable ")));
            await rest;
            controller.enqueue(encoder.encode(chatCompletionsToken("Objects")));
            controller.enqueue(encoder.encode(chatCompletionsTail()));
            controller.close();
          },
        });
        return new HttpResponse(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    deliverRest();

    // The save outlives the request, so it is not readable the moment the
    // client hangs up
    await expect
      .poll(async () => (await readChatHistory(pdfId, selectionId)).map((m) => m.role), {
        timeout: 5000,
        interval: 50,
      })
      .toStrictEqual(["user", "assistant"]);

    const [, answer] = await readChatHistory(pdfId, selectionId);
    expect(answer).toStrictEqual({
      id: expect.any(String),
      role: "assistant",
      content: "Durable Objects",
      citations: [],
      createdAt: expect.any(String),
    });
  });

  it("tells the client the answer was lost when it cannot be saved", async () => {
    const { pdfId, selectionId } = await createSelection("chat-save-failure");
    const encoder = new TextEncoder();

    // Hold the tail of the answer back so the highlight can be deleted while
    // the answer is still streaming. The row the answer is saved as points at
    // that highlight, so the save is refused once it is gone.
    let deliverRest!: () => void;
    const rest = new Promise<void>((resolve) => {
      deliverRest = resolve;
    });

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, () => {
        const body = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(chatCompletionsToken("Durable ")));
            await rest;
            controller.enqueue(encoder.encode(chatCompletionsToken("Objects")));
            controller.enqueue(encoder.encode(chatCompletionsTail()));
            controller.close();
          },
        });
        return new HttpResponse(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value);

    await apiFetch(`https://example.com/api/pdf/${pdfId}/selections/${selectionId}`, {
      method: "DELETE",
    });
    deliverRest();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }

    const events = parseSse(received);
    expect(events.map((e) => e.event)).toStrictEqual(["token", "token", "error"]);
    expect(events[2].data).toStrictEqual({
      code: "CHAT_SAVE_FAILED",
      message: "The answer could not be saved",
    });
  });

  it("reports an upstream failure to the client as an error event", async () => {
    const { pdfId, selectionId } = await createSelection("chat-upstream-error");

    server.use(
      http.post(
        `${LLM_BASE}/chat/completions`,
        () => new HttpResponse("upstream is down", { status: 503 }),
      ),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    expect(events.map((e) => e.event)).toStrictEqual(["error"]);
    expect(events[0].data).toStrictEqual({ code: "AI_API_ERROR", message: expect.any(String) });
  });

  it('rejects a useWebSearch sent as the string "false" instead of reading it as on', async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch-string");

    const response = await postChat(pdfId, selectionId, {
      content: "Where do Workers run?",
      useWebSearch: "false",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request body: useWebSearch" },
    });
    // The question is not stored either, so a rejected ask leaves no trace
    expect(await readChatHistory(pdfId, selectionId)).toStrictEqual([]);
  });

  it("rejects an empty question rather than asking the model about nothing", async () => {
    const { pdfId, selectionId } = await createSelection("chat-empty-content");

    const response = await postChat(pdfId, selectionId, { content: "", useWebSearch: false });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request body: content" },
    });
    expect(await readChatHistory(pdfId, selectionId)).toStrictEqual([]);
  });

  it("refuses to ask about a highlight that is not there", async () => {
    // What a second tab sends after the first deleted the highlight. Answering
    // would spend a whole book's worth of context on a passage nobody has.
    const { pdfId } = await createSelection("chat-unknown-selection");

    const response = await postChat(pdfId, "no-such-highlight", {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" },
    });
  });

  it("says a conversation asked for by an unknown highlight is not there, rather than showing none", async () => {
    // An empty list would read as "this passage has never been asked about",
    // which is a different thing from the passage being gone.
    const { pdfId } = await createSelection("chat-unknown-history");

    const response = await apiFetch(
      `https://example.com/api/pdf/${pdfId}/selections/no-such-highlight/chats`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" },
    });
  });

  it("still serves a conversation holding an answer whose stored citations cannot be read", async () => {
    const { pdfId, selectionId } = await createSelection("chat-broken-citations");
    await env.DB.prepare(
      "INSERT INTO chat_messages (id, selection_id, pdf_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "chat-broken-citations-answer",
        selectionId,
        pdfId,
        "assistant",
        "エッジで動きます",
        "{not json",
        "2026-01-01T00:00:00Z",
      )
      .run();

    expect(await readChatHistory(pdfId, selectionId)).toStrictEqual([
      {
        id: "chat-broken-citations-answer",
        role: "assistant",
        content: "エッジで動きます",
        citations: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("sends the new question once, after the earlier turns, when asking a follow-up", async () => {
    const { pdfId, selectionId } = await createSelection("chat-history-no-duplicate");
    const sentMessages: unknown[] = [];

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { messages: unknown };
        sentMessages.push(body.messages);
        return new HttpResponse(chatCompletionsSse(["Durable Objects"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    // Draining each response waits for the answer to be saved, so the second
    // ask really does start from a stored one-round conversation.
    await (
      await postChat(pdfId, selectionId, {
        content: "What are Durable Objects?",
        useWebSearch: false,
      })
    ).text();
    await (
      await postChat(pdfId, selectionId, {
        content: "How consistent are they?",
        useWebSearch: false,
      })
    ).text();

    expect(sentMessages).toStrictEqual([
      [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "What are Durable Objects?" },
      ],
      [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "What are Durable Objects?" },
        { role: "assistant", content: "Durable Objects" },
        { role: "user", content: "How consistent are they?" },
      ],
    ]);

    // Both questions are still stored, so reopening the chat shows them
    expect(await readChatHistory(pdfId, selectionId)).toStrictEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "What are Durable Objects?",
        citations: null,
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        role: "assistant",
        content: "Durable Objects",
        citations: [],
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        role: "user",
        content: "How consistent are they?",
        citations: null,
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        role: "assistant",
        content: "Durable Objects",
        citations: [],
        createdAt: expect.any(String),
      },
    ]);
  });

  it("hands the model the earlier turns when web search is on", async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch-history");
    const sentInputs: unknown[] = [];
    const answer = 'They keep state on one thread.\n\n## Sources\n[1] "Durable Objects"';

    server.use(
      http.post(`${LLM_BASE}/responses`, async ({ request }) => {
        const body = (await request.json()) as { input: unknown };
        sentInputs.push(body.input);
        return new HttpResponse(responsesSse([answer]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    await (
      await postChat(pdfId, selectionId, {
        content: "What are Durable Objects?",
        useWebSearch: true,
      })
    ).text();
    await (
      await postChat(pdfId, selectionId, { content: "Are they consistent?", useWebSearch: true })
    ).text();

    // Same conversation the other endpoint gets: the earlier turns, with the
    // stored answer's Sources section left out of what is paid for again
    expect(sentInputs).toStrictEqual([
      [{ type: "message", role: "user", content: "What are Durable Objects?" }],
      [
        { type: "message", role: "user", content: "What are Durable Objects?" },
        { type: "message", role: "assistant", content: "They keep state on one thread." },
        { type: "message", role: "user", content: "Are they consistent?" },
      ],
    ]);
  });

  it("records nothing reused when the answer reports no cache figure", async () => {
    const { pdfId, selectionId } = await createSelection("chat-token-counts-no-cache");

    server.use(
      http.post(
        `${LLM_BASE}/chat/completions`,
        () =>
          new HttpResponse(chatCompletionsSse(["Durable Objects"], null), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    await (
      await postChat(pdfId, selectionId, {
        content: "What are Durable Objects?",
        useWebSearch: false,
      })
    ).text();

    // Zero, not null: the answer was measured and none of the book was reused,
    // which a cost report has to tell apart from a row written before measuring
    expect(await readTokenCounts(selectionId)).toStrictEqual({
      input_tokens: 11,
      output_tokens: 2,
      cached_input_tokens: 0,
    });
  });

  it("hands the model the earlier turns in the order they were written", async () => {
    const { pdfId, selectionId } = await createSelection("chat-history-order");
    await seedTurnsWrittenOutOfOrder(selectionId);
    const sentMessages: unknown[] = [];

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { messages: unknown };
        sentMessages.push(body.messages);
        return new HttpResponse(chatCompletionsSse(["Yes"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    await (
      await postChat(pdfId, selectionId, { content: "Are they consistent?", useWebSearch: false })
    ).text();

    // An answer read before the question it answers reads as the model having
    // replied to nothing, which is what an unordered history hands it.
    expect(sentMessages).toStrictEqual([
      [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "What are Durable Objects?" },
        { role: "assistant", content: "They keep state on one thread." },
        { role: "user", content: "Are they consistent?" },
      ],
    ]);
  });

  it("shows a reopened conversation in the order it was written", async () => {
    const { pdfId, selectionId } = await createSelection("chat-history-order-read");
    const { questionId, answerId } = await seedTurnsWrittenOutOfOrder(selectionId);

    expect(await readChatHistory(pdfId, selectionId)).toStrictEqual([
      {
        id: questionId,
        role: "user",
        content: "What are Durable Objects?",
        citations: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: answerId,
        role: "assistant",
        content: "They keep state on one thread.",
        citations: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
  });

  it("asks the model the deploy named, with the key it was given", async () => {
    // The model this app was written against and DeepSeek's own key would both
    // be accepted by a mock that only checked the URL, so what is actually
    // sent is read back here: a config threaded through to the wrong field, or
    // dropped on the way, is otherwise invisible until a real provider refuses.
    const { pdfId, selectionId } = await createSelection("chat-model-from-env");
    const asked: { model: unknown; authorization: string | null }[] = [];

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { model: unknown };
        asked.push({ model: body.model, authorization: request.headers.get("Authorization") });
        return new HttpResponse(chatCompletionsSse(["Everywhere"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, { content: "Where do Workers run?" });
    await response.text();

    expect(asked).toStrictEqual([{ model: LLM_MODEL, authorization: `Bearer ${LLM_KEY}` }]);
  });

  it("leaves web search off when the request does not mention it", async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch-default");
    const calledUrls: string[] = [];

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, ({ request }) => {
        calledUrls.push(request.url);
        return new HttpResponse(chatCompletionsSse(["Everywhere"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, { content: "Where do Workers run?" });

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());

    expect(calledUrls).toStrictEqual([`${LLM_BASE}/chat/completions`]);
    expect(events.map((e) => e.event)).toStrictEqual(["token", "done"]);
    expect(events[0].data).toStrictEqual({ content: "Everywhere" });
  });
});

describe("a provider that has no web search to offer", () => {
  it("asks it the ordinary way even when the reader still has the switch on", async () => {
    // The switch is remembered in the reader's own browser, so one thrown at a
    // provider without a Responses API would otherwise reach an endpoint that
    // is not there and come back as an answer that failed.
    const { pdfId, selectionId } = await createSelection("chat-websearch-unsupported");
    const calledUrls: string[] = [];
    const token = await issueSession(env.AUTH_SESSION_SECRET, Date.now());

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, ({ request }) => {
        calledUrls.push(request.url);
        return new HttpResponse(chatCompletionsSse(["Everywhere"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
      http.post(`${LLM_BASE}/responses`, ({ request }) => {
        calledUrls.push(request.url);
        return new HttpResponse(responsesSse(["Everywhere"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    // The route hands the rest of the stream to `waitUntil`, which needs a
    // context of its own when the request does not come in through the export.
    const ctx = createExecutionContext();
    const response = await app.request(
      `https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ content: "Where do Workers run?", useWebSearch: true }),
      },
      { ...env, LLM_WEB_SEARCH_SUPPORTED: "false" },
      ctx,
    );

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    await waitOnExecutionContext(ctx);

    expect(calledUrls).toStrictEqual([`${LLM_BASE}/chat/completions`]);
    expect(events.map((e) => e.event)).toStrictEqual(["token", "done"]);
    expect(events[0].data).toStrictEqual({ content: "Everywhere" });
  });
});

describe("a deploy that has not been given a key for the model yet", () => {
  it("says the server is not configured rather than asking the model without a key", async () => {
    // Reaching the provider unauthenticated would come back as a stream that
    // errors, which reads to the reader as the answer having gone wrong.
    const { pdfId, selectionId } = await createSelection("chat-no-api-key");
    const token = await issueSession(env.AUTH_SESSION_SECRET, Date.now());

    const response = await app.request(
      `https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ content: "Where do Workers run?" }),
      },
      { ...env, LLM_API_KEY: "" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      error: { code: "CONFIG_ERROR", message: "LLM_API_KEY not set" },
    });
  });
});

/** A multi-page book whose every page carries a fact of its own to quote. */
const PAGED_BOOK = {
  pages: (count: number) =>
    Array.from({ length: count }, (_, i) => `Page ${i + 1} says fact-${i + 1}.`),
  text: (count: number) => PAGED_BOOK.pages(count).join("\f"),
};

const CHAPTER_OUTLINE = [
  { title: "Chapter 1", pageNumber: 2 },
  { title: "Chapter 2", pageNumber: 5 },
  { title: "Chapter 3", pageNumber: 9 },
];

/** The document block the system prompt hands the model. */
function documentIn(instructions: string): string | undefined {
  return instructions.match(/--- DOCUMENT START ---\n([\s\S]*?)\n--- DOCUMENT END ---/)?.[1];
}

/** The line naming what the model is given as context. */
function contextLineIn(instructions: string): string | undefined {
  return instructions.match(/^Use the following .+$/m)?.[0];
}

describe("chat sends an excerpt instead of the whole book", () => {
  it("sends the chapter holding the highlight, named by its pages", async () => {
    const { pdfId, selectionId } = await createSelection("chat-excerpt-chapter", {
      fullText: PAGED_BOOK.text(12),
      pageCount: 12,
      outline: CHAPTER_OUTLINE,
      selectionPage: 6,
    });
    let systemPrompt = "";

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        systemPrompt = body.messages[0].content;
        return new HttpResponse(chatCompletionsSse(["ok"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What does chapter 2 say?",
      useWebSearch: false,
    });
    await response.text();

    expect(documentIn(systemPrompt)).toBe(PAGED_BOOK.pages(12).slice(4, 8).join("\f"));
    expect(contextLineIn(systemPrompt)).toBe(
      "Use the following excerpt (pages 5-8 of the 12-page document) as your primary context:",
    );
  });

  it("sends a page window around the highlight when the book has no outline", async () => {
    const { pdfId, selectionId } = await createSelection("chat-excerpt-window", {
      fullText: PAGED_BOOK.text(30),
      pageCount: 30,
      selectionPage: 15,
    });
    let systemPrompt = "";

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        systemPrompt = body.messages[0].content;
        return new HttpResponse(chatCompletionsSse(["ok"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What is around here?",
      useWebSearch: false,
    });
    await response.text();

    expect(documentIn(systemPrompt)).toBe(PAGED_BOOK.pages(30).slice(4, 25).join("\f"));
    expect(contextLineIn(systemPrompt)).toBe(
      "Use the following excerpt (pages 5-25 of the 30-page document) as your primary context:",
    );
  });

  it("resolves a passage quoted from the excerpt to its page in the whole book", async () => {
    const { pdfId, selectionId } = await createSelection("chat-excerpt-citation", {
      fullText: PAGED_BOOK.text(12),
      pageCount: 12,
      outline: CHAPTER_OUTLINE,
      selectionPage: 6,
    });
    // The page lookup runs against the stored full text, not the excerpt: a
    // lookup against the excerpt would call page 6 of the book "page 2".
    const answer = 'It is on page 6[1].\n\n## Sources\n[1] "Page 6 says fact-6."';

    server.use(
      http.post(`${LLM_BASE}/chat/completions`, () => {
        return new HttpResponse(chatCompletionsSse([answer]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "Where is fact-6?",
      useWebSearch: false,
    });
    await response.text();

    const history = await readChatHistory(pdfId, selectionId);
    expect(history[history.length - 1].citations).toStrictEqual([
      { id: "1", type: "pdf", text: "Page 6 says fact-6.", pageNumber: 6 },
    ]);
  });
});
