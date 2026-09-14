import { describe, it, expect } from "vite-plus/test";
import {
  buildSystemPrompt,
  resolveLlmConfig,
  streamResponseWithWebSearch,
  type LlmConfig,
} from "./llmService";
import type { DocumentExcerpt } from "./documentExcerpt";

const TEST_CONFIG: LlmConfig = {
  apiKey: "test-key",
  baseURL: "https://llm.test",
  model: "test-model",
};

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
  let usage: unknown = null;

  await streamResponseWithWebSearch(
    TEST_CONFIG,
    "system prompt",
    [{ role: "user", content: "Where do Workers run?" }],
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
  it("delivers the text deltas and the token counts when the stream completes normally", async () => {
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: "Workers " }),
      sseData({ type: "response.output_text.delta", delta: "run everywhere" }),
      sseData({
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 2 } },
      }),
    ]);

    expect(tokens).toStrictEqual(["Workers ", "run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 0 });
    expect(errors).toStrictEqual([]);
  });

  it("reports how much of the input was served from the prompt cache when the stream says so", async () => {
    // A chapter of the book rides in front of every question, so what the
    // cache covered is the difference between paying full price and 1/50th.
    const { usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      sseData({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 11,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 9 },
          },
        },
      }),
    ]);

    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 9 });
  });

  it("skips a delta that is not text instead of writing it into the answer", async () => {
    // A non-string delta used to be concatenated as "[object Object]" and saved
    // to D1 as part of the answer.
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: { annotation: "web" } }),
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      sseData({ type: "response.output_text.delta", delta: 42 }),
      sseData({
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 2 } },
      }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 0 });
    // Silently skipped, not reported: a delta the reader has no use for is not
    // a failure to show in the chat
    expect(errors).toStrictEqual([]);
  });

  it("keeps reading the answer past an event of a type it does not know", async () => {
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.web_search_call.in_progress" }),
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      sseData({
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 2 } },
      }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 0 });
    expect(errors).toStrictEqual([]);
  });

  it("keeps reading the answer past a line that is not JSON at all", async () => {
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
      "data: {not json",
      sseData({
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 2 } },
      }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 0 });
    expect(errors).toStrictEqual([]);
  });

  it("reports a refusal from the model's own API rather than finishing on an empty answer", async () => {
    // The route turns this into the `error` event the chat panel shows. Ending
    // instead through `onDone` would save an empty answer as if it were one.
    const tokens: string[] = [];
    const errors: string[] = [];
    let completions = 0;

    await streamResponseWithWebSearch(
      TEST_CONFIG,
      "system prompt",
      [{ role: "user", content: "Where do Workers run?" }],
      {
        onToken: (token) => tokens.push(token),
        onDone: () => {
          completions += 1;
        },
        onError: (err) => errors.push(err.message),
      },
      undefined,
      () => Promise.resolve(new Response("upstream is down", { status: 503 })),
    );

    expect(errors).toStrictEqual(["Responses API error 503: upstream is down"]);
    expect(tokens).toStrictEqual([]);
    expect(completions).toBe(0);
  });

  it("finishes an answer that stopped before it said what it cost, rather than losing it", async () => {
    // A stream cut short still carries an answer the reader has already been
    // shown, so it is completed with nothing counted instead of thrown away.
    const { tokens, errors, usage } = await readWebSearchStream([
      sseData({ type: "response.output_text.delta", delta: "Workers run everywhere" }),
    ]);

    expect(tokens).toStrictEqual(["Workers run everywhere"]);
    expect(usage).toStrictEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(errors).toStrictEqual([]);
  });
});

const BOOK = "Workers execute on Cloudflare's global network.";
const PASSAGE = "global network";

/** A book small enough that its excerpt is the whole text. */
const WHOLE_BOOK: DocumentExcerpt = {
  text: BOOK,
  startPage: 1,
  endPage: 1,
  totalPages: 1,
  isPartial: false,
};

/** A chapter cut out of a longer book. */
const CHAPTER: DocumentExcerpt = {
  text: BOOK,
  startPage: 5,
  endPage: 8,
  totalPages: 12,
  isPartial: true,
};

/** What the prompt hands the model between a pair of its markers. */
function between(prompt: string, start: string, end: string): string {
  return prompt.slice(prompt.indexOf(start) + start.length, prompt.indexOf(end)).trim();
}

/** The fixed lines the instructions that change sit between. */
const TABLE_RULE = "- For tabular comparisons, use a markdown table, not a diagram.";
const MERMAID_RULE =
  "- When a diagram helps, write it as a ```mermaid fenced code block using flowchart, sequenceDiagram or stateDiagram-v2 syntax valid in Mermaid 11. Invalid mermaid is shown to the reader as raw code, so double-check the syntax.";
const CITATION_RULES = "When answering, follow these citation rules strictly:";

describe("buildSystemPrompt", () => {
  it("puts the book and the highlighted passage where it tells the model to look for them", () => {
    // Read back through the markers the prompt names rather than the whole
    // text: those markers are what the model is told to read between, so they
    // are the contract, while the wording around them is tuned freely.
    const prompt = buildSystemPrompt(WHOLE_BOOK, PASSAGE, true);

    expect(between(prompt, "--- DOCUMENT START ---", "--- DOCUMENT END ---")).toBe(BOOK);
    expect(between(prompt, "--- HIGHLIGHTED PASSAGE ---", "--- END HIGHLIGHTED PASSAGE ---")).toBe(
      PASSAGE,
    );
  });

  it("shuts the model in with the document when the reader turns web search off", () => {
    const off = buildSystemPrompt(WHOLE_BOOK, PASSAGE, false);

    expect(between(off, TABLE_RULE, CITATION_RULES)).toBe(
      "Respond using only the document context. If the document does not contain the answer, say so clearly.",
    );
    // And the rest of the prompt is the same one: an instruction that went
    // missing rather than being swapped would leave this to fail too.
    expect(off).toBe(
      buildSystemPrompt(WHOLE_BOOK, PASSAGE, true).replace(
        "When the document does not contain enough information to answer the question, you may use web search to find additional context. Always indicate when you are using external sources.",
        "Respond using only the document context. If the document does not contain the answer, say so clearly.",
      ),
    );
  });

  it("lets the model reach for the web when the reader leaves search on", () => {
    expect(between(buildSystemPrompt(WHOLE_BOOK, PASSAGE, true), TABLE_RULE, CITATION_RULES)).toBe(
      "When the document does not contain enough information to answer the question, you may use web search to find additional context. Always indicate when you are using external sources.",
    );
  });

  it("presents a whole book as the document, with no excerpt talk", () => {
    const prompt = buildSystemPrompt(WHOLE_BOOK, PASSAGE, true);

    expect(
      between(
        prompt,
        "You are a helpful AI assistant analyzing a PDF document.",
        "--- DOCUMENT START ---",
      ),
    ).toBe("Use the following document as your primary context:");
    expect(
      between(
        prompt,
        "- Answer questions based primarily on the document content.",
        "- Keep answers concise",
      ),
    ).toBe(
      "- When the document does not contain the answer, say so clearly, then provide what you know.",
    );
  });

  it("names the pages an excerpt covers so the model knows what it is holding", () => {
    const prompt = buildSystemPrompt(CHAPTER, PASSAGE, true);

    expect(
      between(
        prompt,
        "You are a helpful AI assistant analyzing a PDF document.",
        "--- DOCUMENT START ---",
      ),
    ).toBe(
      "Use the following excerpt (pages 5-8 of the 12-page document) as your primary context:",
    );
    // The markers still carry the excerpt text untouched: anything injected
    // here would break the verbatim substring the citation lookup relies on.
    expect(between(prompt, "--- DOCUMENT START ---", "--- DOCUMENT END ---")).toBe(BOOK);
  });

  it("tells the model to blame the shown pages, not the document, for a missing answer", () => {
    expect(
      between(
        buildSystemPrompt(CHAPTER, PASSAGE, true),
        "- Answer questions based primarily on the document content.",
        "- Keep answers concise",
      ),
    ).toBe(
      "- You are shown only pages 5-8; the rest of the document is not visible to you. When the shown pages do not contain the answer, say it is not in the shown pages rather than not in the document, then provide what you know.",
    );
  });

  it("shuts the model in with the excerpt when the reader turns web search off", () => {
    const off = buildSystemPrompt(CHAPTER, PASSAGE, false);

    expect(between(off, TABLE_RULE, CITATION_RULES)).toBe(
      "Respond using only the excerpt context. If the shown pages do not contain the answer, say so clearly.",
    );
    // The excerpt prompt composes the same way the whole-book one does: web
    // search swaps one instruction and leaves the rest alone.
    expect(off).toBe(
      buildSystemPrompt(CHAPTER, PASSAGE, true).replace(
        "When the shown pages do not contain enough information to answer the question, you may use web search to find additional context. Always indicate when you are using external sources.",
        "Respond using only the excerpt context. If the shown pages do not contain the answer, say so clearly.",
      ),
    );
  });

  it("lets the model reach for the web past an excerpt when search is on", () => {
    expect(between(buildSystemPrompt(CHAPTER, PASSAGE, true), TABLE_RULE, CITATION_RULES)).toBe(
      "When the shown pages do not contain enough information to answer the question, you may use web search to find additional context. Always indicate when you are using external sources.",
    );
  });

  // mermaid stays the first choice wherever it can draw the figure; this is
  // what an answer reaches for when it cannot. The caption it writes is what
  // the reader's link says — src/front/lib/htmlDiagram.ts reads it back.
  it("offers the model html for the figures mermaid cannot draw", () => {
    expect(between(buildSystemPrompt(WHOLE_BOOK, PASSAGE, true), MERMAID_RULE, TABLE_RULE)).toBe(
      '- When mermaid cannot draw it — a free-form layout, two structures side by side, a chart it has no syntax for — write the diagram as a ```html fenced code block instead, captioned so the reader knows what they are opening: ```html title="キャッシュの流れ". They never see this code, only a link that opens the document in a popup, so write a self-contained document — styles and scripts inline, nothing loaded from outside, nothing kept in browser storage.',
    );
  });
});

describe("resolveLlmConfig", () => {
  it("falls back to DeepSeek when the deploy names no provider of its own", () => {
    // What every existing deploy runs on: the key was the only thing set, so
    // saying nothing has to keep meaning what it meant before.
    expect(resolveLlmConfig({ LLM_API_KEY: "a-key" })).toStrictEqual({
      apiKey: "a-key",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      webSearchSupported: true,
    });
  });

  it("takes the endpoint and the model the deploy names", () => {
    expect(
      resolveLlmConfig({
        LLM_API_KEY: "a-key",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_MODEL: "gpt-5.2",
      }),
    ).toStrictEqual({
      apiKey: "a-key",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.2",
      webSearchSupported: true,
    });
  });

  it("treats an empty setting as one nobody wrote, rather than as an empty endpoint", () => {
    // `wrangler secret put` and a `.dev.vars` line left blank both arrive as
    // "", and an empty baseURL would send every request to this Worker itself.
    expect(
      resolveLlmConfig({ LLM_API_KEY: "a-key", LLM_BASE_URL: "", LLM_MODEL: "" }),
    ).toStrictEqual({
      apiKey: "a-key",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      webSearchSupported: true,
    });
  });

  it.each([
    ["false", false],
    ["0", false],
    ["true", true],
    ["", true],
    ["yes", true],
  ])("reads %o as web search being %o", (declared, supported) => {
    expect(
      resolveLlmConfig({ LLM_API_KEY: "a-key", LLM_WEB_SEARCH_SUPPORTED: declared }),
    ).toStrictEqual({
      apiKey: "a-key",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      webSearchSupported: supported,
    });
  });
});
