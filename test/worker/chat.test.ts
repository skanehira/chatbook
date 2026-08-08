import { describe, it, expect, beforeAll } from "vite-plus/test";
import { env, applyD1Migrations, SELF } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { MINIMAL_PDF_BYTES } from "./fixtures/minimalPdf";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** The book's text. The highlighted passage is deliberately absent from it, so
 * a prompt that drops the selection cannot pass by quoting the book instead. */
const BOOK_TEXT = "Workers run on Cloudflare's global network.";
const HIGHLIGHTED_PASSAGE = "Durable Objects";

/**
 * A book plus a highlighted passage, which is what a chat hangs off.
 *
 * Books are de-duplicated by content hash and D1 is only isolated per test
 * file, so each test appends its own PDF comment to get a book of its own.
 */
async function createSelection(tag: string): Promise<{ pdfId: string; selectionId: string }> {
  const suffix = new TextEncoder().encode(`\n%${tag}\n`);
  const bytes = new Uint8Array(MINIMAL_PDF_BYTES.length + suffix.length);
  bytes.set(MINIMAL_PDF_BYTES, 0);
  bytes.set(suffix, MINIMAL_PDF_BYTES.length);

  const formData = new FormData();
  formData.append("file", new File([bytes], `${tag}.pdf`, { type: "application/pdf" }));
  formData.append("fullText", BOOK_TEXT);
  formData.append("pageCount", "1");

  const uploadResponse = await SELF.fetch("https://example.com/api/pdf/open", {
    method: "POST",
    body: formData,
  });
  const { id: pdfId } = (await uploadResponse.json()) as { id: string };

  const selectionResponse = await SELF.fetch(`https://example.com/api/pdf/${pdfId}/selections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedText: HIGHLIGHTED_PASSAGE,
      pageNumber: 1,
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

/** What closes a chat completions stream: the usage chunk, then [DONE]. */
function chatCompletionsTail(): string {
  const usage = JSON.stringify({
    choices: [{ delta: {} }],
    usage: { prompt_tokens: 11, completion_tokens: 2 },
  });
  return `data: ${usage}\n\ndata: [DONE]\n\n`;
}

/** An SSE body shaped like the chat completions stream, ending in [DONE]. */
function chatCompletionsSse(tokens: string[]): string {
  return tokens.map(chatCompletionsToken).join("") + chatCompletionsTail();
}

/** An SSE body shaped like the responses API stream used for web search. */
function responsesSse(tokens: string[]): string {
  const chunks = tokens.map(
    (token) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: token })}`,
  );
  chunks.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      usage: { input_tokens: 11, output_tokens: 2 },
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
  const response = await SELF.fetch(
    `https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`,
  );
  expect(response.status).toBe(200);
  const { messages } = (await response.json()) as { messages: StoredMessage[] };
  return messages;
}

async function postChat(pdfId: string, selectionId: string, payload: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/api/pdf/${pdfId}/selections/${selectionId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/pdf/:pdfId/selections/:selId/chats", () => {
  it("streams tokens from the chat completions endpoint as SSE when web search is off", async () => {
    const { pdfId, selectionId } = await createSelection("chat-stream");
    const calledUrls: string[] = [];

    server.use(
      http.post("https://api.deepseek.com/chat/completions", ({ request }) => {
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

    expect(calledUrls).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect(events.map((e) => e.event)).toEqual(["token", "token", "done"]);
    expect(events.slice(0, 2).map((e) => e.data)).toEqual([
      { content: "Durable " },
      { content: "Objects" },
    ]);
    expect(events[2].data).toEqual({
      messageId: expect.any(String),
      usage: { inputTokens: 11, outputTokens: 2 },
    });
  });

  it("sends the highlighted passage as context and asks for web search when it is on", async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch");
    let requestBody: Record<string, unknown> = {};

    server.use(
      http.post("https://api.deepseek.com/responses", async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
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

    expect(requestBody.tools).toEqual([{ type: "web_search" }]);
    expect(requestBody.input).toEqual([
      { type: "message", role: "user", content: "Where do Workers run?" },
    ]);
    expect(highlightedPassageIn(String(requestBody.instructions))).toBe(HIGHLIGHTED_PASSAGE);

    expect(events.map((e) => e.event)).toEqual(["token", "token", "done"]);
    expect(events.slice(0, 2).map((e) => e.data)).toEqual([
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
      http.post("https://api.deepseek.com/chat/completions", () => {
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
      .toEqual(["user", "assistant"]);

    const [, answer] = await readChatHistory(pdfId, selectionId);
    expect(answer).toEqual({
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
      http.post("https://api.deepseek.com/chat/completions", () => {
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

    await SELF.fetch(`https://example.com/api/pdf/${pdfId}/selections/${selectionId}`, {
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
        "https://api.deepseek.com/chat/completions",
        () => new HttpResponse("upstream is down", { status: 503 }),
      ),
    );

    const response = await postChat(pdfId, selectionId, {
      content: "What are Durable Objects?",
      useWebSearch: false,
    });

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(events[0].data).toEqual({ code: "AI_API_ERROR", message: expect.any(String) });
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

  it("still serves a conversation holding an answer whose stored citations cannot be read", async () => {
    const { pdfId, selectionId } = await createSelection("chat-broken-citations");
    await env.DB.prepare(
      "INSERT INTO chat_messages (id, selection_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "chat-broken-citations-answer",
        selectionId,
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

  it("leaves web search off when the request does not mention it", async () => {
    const { pdfId, selectionId } = await createSelection("chat-websearch-default");
    const calledUrls: string[] = [];

    server.use(
      http.post("https://api.deepseek.com/chat/completions", ({ request }) => {
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

    expect(calledUrls).toStrictEqual(["https://api.deepseek.com/chat/completions"]);
    expect(events.map((e) => e.event)).toStrictEqual(["token", "done"]);
    expect(events[0].data).toStrictEqual({ content: "Everywhere" });
  });
});
