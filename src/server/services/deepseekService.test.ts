import { describe, it, expect } from "vite-plus/test";
import { streamResponseWithWebSearch } from "./deepseekService";

/** A Responses API answer made of the given SSE lines, served to the injected fetch. */
function respondingWith(lines: string[]): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(new TextEncoder().encode(lines.map((line) => `${line}\n\n`).join("")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

/** Run the web-search stream against a canned body and collect what it reported. */
async function readWebSearchStream(lines: string[]) {
  const tokens: string[] = [];
  const errors: string[] = [];
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  await streamResponseWithWebSearch(
    "test-key",
    "system prompt",
    "Where do Workers run?",
    {
      onToken: (token) => tokens.push(token),
      onDone: (reported) => {
        usage = reported;
      },
      onError: (err) => errors.push(err.message),
    },
    undefined,
    respondingWith(lines),
  );

  return { tokens, errors, usage };
}

describe("streamResponseWithWebSearch", () => {
  it("delivers the text deltas of the stream and the token counts it ends with", async () => {
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: "Workers " }),
      sseData({ type: "response.output_text.delta", delta: "run everywhere" }),
      sseData({ type: "response.completed", usage: { input_tokens: 11, output_tokens: 2 } }),
    ]);

    expect(tokens).toStrictEqual(["Workers ", "run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2 });
    expect(errors).toStrictEqual([]);
  });

  it("skips a delta that is not text instead of writing it into the answer", async () => {
    // A non-string delta used to be concatenated as "[object Object]" and saved
    // to D1 as part of the answer.
    const { tokens, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: { annotation: "web" } }),
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      sseData({ type: "response.output_text.delta", delta: 42 }),
      sseData({ type: "response.completed", usage: { input_tokens: 11, output_tokens: 2 } }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2 });
  });

  it("keeps reading the answer past an event whose shape it does not know", async () => {
    const { tokens, usage } = await readWebSearchStream([
      sseData({ type: "response.web_search_call.in_progress" }),
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      "data: {not json",
      sseData({ type: "response.completed", usage: { input_tokens: 11, output_tokens: 2 } }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2 });
  });
});
