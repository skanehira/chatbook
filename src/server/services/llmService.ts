import OpenAI from "openai";
import { z } from "zod";
import type { ConversationTurn, LlmMessage } from "./chatService";
import { describePages, type DocumentExcerpt } from "./documentExcerpt";

/**
 * The Responses API events this reader acts on.
 *
 * A `delta` is only ever appended to the answer when it really is text: the
 * stream also carries deltas for annotations and tool calls, and one of those
 * used to land in the saved answer as "[object Object]". Everything that does
 * not match — including an empty delta — is skipped.
 */
const responseStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response.output_text.delta"),
    delta: z.string().min(1),
  }),
  z.object({
    type: z.literal("response.completed"),
    // What the answer cost rides inside the finished response object, not on
    // the event: `{ type, sequence_number, response: { …, usage } }`
    response: z
      .object({
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
]);

/**
 * The extra field DeepSeek puts on a chat completions usage chunk.
 *
 * The OpenAI SDK types have no room for it, so the chunk is re-read here rather
 * than cast: a shape nobody validated is exactly what the rest of this codebase
 * refuses to trust.
 *
 * Optional because it is DeepSeek's alone: a provider that reports its cache
 * some other way, or not at all, is counted as zero rather than refused.
 */
const chatCompletionsCacheUsageSchema = z.object({
  prompt_cache_hit_tokens: z.number().optional(),
});

/**
 * What a finished answer cost.
 *
 * `cachedInputTokens` is the part of the input DeepSeek served from its context
 * cache at 1/50th the price. A chapter of the book rides in front of every
 * question (see documentExcerpt.ts), and within one conversation it is always
 * the same chapter, so this is the number that says whether that repeat is
 * expensive or nearly free.
 */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Which OpenAI-compatible endpoint answers, as what model, with which key. */
export interface LlmConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** The provider this app was written against, and what a deploy gets by default. */
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

/** What the Worker is told about the model it should ask. */
interface LlmEnv {
  LLM_API_KEY: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_WEB_SEARCH_SUPPORTED?: string;
}

/**
 * The provider a deploy is pointed at, with DeepSeek where it says nothing.
 *
 * The defaults are here rather than in `wrangler.jsonc` so that a deploy which
 * predates these settings — every one that only ever had an API key — keeps
 * reaching the same provider without anyone adding vars to bring it back.
 *
 * `webSearchSupported` is a claim about the provider, not a reader's choice:
 * the web-search path posts to a Responses API with a `web_search` tool, which
 * an OpenAI-compatible endpoint need not have. Opting out is spelled out
 * explicitly (`"false"` / `"0"`) so a typo leaves the DeepSeek default intact
 * rather than silently taking the feature away.
 */
export function resolveLlmConfig(env: LlmEnv): LlmConfig & { webSearchSupported: boolean } {
  const declined = env.LLM_WEB_SEARCH_SUPPORTED === "false" || env.LLM_WEB_SEARCH_SUPPORTED === "0";

  return {
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL || DEFAULT_BASE_URL,
    model: env.LLM_MODEL || DEFAULT_MODEL,
    webSearchSupported: !declined,
  };
}

interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Awaited, so a caller can persist the answer before this resolves. */
  onDone: (usage: StreamUsage) => void | Promise<void>;
  onError: (error: Error) => void;
}

/**
 * Build the system prompt for the AI assistant.
 *
 * The document block carries an excerpt rather than the whole book. All the
 * excerpt-awareness lives in the wording *around* the DOCUMENT markers —
 * nothing is ever injected between them, so the model's quotes stay verbatim
 * substrings of the stored full text and the citation page lookup keeps
 * finding them. A whole-book excerpt (isPartial false) produces exactly the
 * wording this prompt always had: a one-page book is never told it is
 * looking at a fragment.
 */
export function buildSystemPrompt(
  excerpt: DocumentExcerpt,
  /**
   * The passage the question is about, or null when it is about the document
   * itself — a summary, or a question about the book as a whole.
   */
  selectedText: string | null,
  useWebSearch: boolean,
): string {
  const { text, ranges, totalPages, isPartial } = excerpt;
  const pages = describePages(ranges);

  const contextName = isPartial
    ? `excerpt (pages ${pages} of the ${totalPages}-page document)`
    : "document";
  // "the shown pages do" / "the document does": the subject and its verb
  // travel together so the two variants stay grammatical in every slot.
  const scopeDoes = isPartial ? "the shown pages do" : "the document does";
  const missingAnswerInstruction = isPartial
    ? `- You are shown only pages ${pages}; the rest of the document is not visible to you. When the shown pages do not contain the answer, say it is not in the shown pages rather than not in the document, then provide what you know.`
    : `- When the document does not contain the answer, say so clearly, then provide what you know.`;
  const webSearchInstruction = useWebSearch
    ? `\n\nWhen ${scopeDoes} not contain enough information to answer the question, you may use web search to find additional context. Always indicate when you are using external sources.`
    : `\n\nRespond using only the ${isPartial ? "excerpt" : "document"} context. If ${scopeDoes} not contain the answer, say so clearly.`;

  // Nothing at all when there is no passage: a question put to the book itself
  // has none, and telling the model one was highlighted would have it hunting
  // for a passage that is not there.
  const highlight =
    selectedText === null
      ? ""
      : `The user has highlighted this specific passage and is asking about it:
--- HIGHLIGHTED PASSAGE ---
${selectedText}
--- END HIGHLIGHTED PASSAGE ---

`;

  // Only where there is a gap to mind: one run of pages arrives whole, and a
  // warning about a seam that is not there makes the model quote more
  // cautiously than the excerpt needs.
  const parts =
    ranges.length > 1
      ? `- The pages you are shown arrive in ${ranges.length} parts (pages ${pages}); the pages between them are not visible to you. Quote from within one part rather than joining the end of one to the start of the next.\n`
      : "";

  return `You are a helpful AI assistant analyzing a PDF document.
Use the following ${contextName} as your primary context:

--- DOCUMENT START ---
${text}
--- DOCUMENT END ---

${highlight}Instructions:
${parts}- Answer questions based primarily on the document content.
${missingAnswerInstruction}
- Keep answers concise and well-structured.
- When a diagram helps, write it as a \`\`\`mermaid fenced code block using flowchart, sequenceDiagram or stateDiagram-v2 syntax valid in Mermaid 11. Invalid mermaid is shown to the reader as raw code, so double-check the syntax.
- When mermaid cannot draw it — a free-form layout, two structures side by side, a chart it has no syntax for — write the diagram as a \`\`\`html fenced code block instead, captioned so the reader knows what they are opening: \`\`\`html title="キャッシュの流れ". They never see this code, only a link that opens the document in a popup, so write a self-contained document — styles and scripts inline, nothing loaded from outside, nothing kept in browser storage.
- For tabular comparisons, use a markdown table, not a diagram.${webSearchInstruction}

When answering, follow these citation rules strictly:
1. Reference sources inline using [n] notation.
2. For PDF content: cite the exact passage you're referencing.
3. For web search results: cite the page title and URL.
4. At the end of every response, include a "## Sources" section listing all citations:
   - [n] "exact quoted text from the document"
   - [n] "exact quoted text from the page" - Page Title - URL
5. One quoted passage per entry. Do not name the section it comes from, and do not quote a second passage in the same entry — give it its own [n]. Quote Japanese passages with 「」.
6. End a web entry with its URL and write nothing after it: no parentheses around it, no trailing punctuation. A document entry carries no URL of its own.

Example:
The document states that Workers run on Cloudflare's global network[1].
キャッシュの扱いは指定できます[2]。
Service bindings connect two Workers directly[3].

## Sources
[1] "Workers execute on Cloudflare's global network across 300+ cities"
[2] 「public、privateはキャッシュを共有キャッシュとして扱ってよいかの指定に使います」
[3] "you can deploy an authentication service as its own Worker" - Service bindings · Cloudflare Workers docs - https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/`;
}

/**
 * Stream a chat completion from the configured provider (Chat Completions endpoint).
 */
export async function streamChatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  try {
    const stream = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let fullContent = "";
    let usage: StreamUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        callbacks.onToken(delta);
      }
      if (chunk.usage) {
        const cacheUsage = chatCompletionsCacheUsageSchema.safeParse(chunk.usage);
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cachedInputTokens: cacheUsage.success
            ? (cacheUsage.data.prompt_cache_hit_tokens ?? 0)
            : 0,
        };
      }
    }

    await callbacks.onDone(usage);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Stream a response from the provider's Responses API with web_search enabled.
 * Only reached when the provider is declared to support it (`resolveLlmConfig`).
 */
export async function streamResponseWithWebSearch(
  config: LlmConfig,
  systemPrompt: string,
  conversation: ConversationTurn[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetchFn(`${config.baseURL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: conversation.map((turn) => ({
          type: "message",
          role: turn.role,
          content: turn.content,
        })),
        instructions: systemPrompt,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Responses API error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let usage: StreamUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        let payload: unknown;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          // Skip parse errors for partial chunks
          continue;
        }

        const event = responseStreamEventSchema.safeParse(payload);
        if (!event.success) continue;

        if (event.data.type === "response.output_text.delta") {
          callbacks.onToken(event.data.delta);
        } else if (event.data.response?.usage) {
          const reported = event.data.response.usage;
          usage = {
            inputTokens: reported.input_tokens ?? 0,
            outputTokens: reported.output_tokens ?? 0,
            cachedInputTokens: reported.input_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    }

    await callbacks.onDone(usage);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
