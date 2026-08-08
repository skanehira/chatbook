/** A chat endpoint the test feeds by hand, and that gives up when aborted. */

export interface ChatCall {
  url: string;
  body: unknown;
  emit: (sse: string) => void;
  end: () => void;
}

export function tokenEvent(content: string): string {
  return `event: token\ndata: ${JSON.stringify({ content })}\n\n`;
}

export function doneEvent(messageId: string): string {
  return `event: done\ndata: ${JSON.stringify({ messageId })}\n\n`;
}

/** A citation block, with the payload left to the caller so it can be malformed. */
export function citationEvent(citation: unknown): string {
  return `event: citation\ndata: ${JSON.stringify(citation)}\n\n`;
}

export function errorEvent(code: string, message: string): string {
  return `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`;
}

export function streamingFetchStub() {
  const encoder = new TextEncoder();
  const calls: ChatCall[] = [];

  const fetchFn: typeof fetch = (input, init) => {
    if (typeof input !== "string" || typeof init?.body !== "string") {
      throw new Error("the chat endpoint is called with a url and a JSON body");
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    calls.push({
      url: input,
      body: JSON.parse(init.body) as unknown,
      emit: (sse) => controller.enqueue(encoder.encode(sse)),
      end: () => controller.close(),
    });
    init?.signal?.addEventListener("abort", () => {
      controller.error(new DOMException("The operation was aborted.", "AbortError"));
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  return { fetchFn, calls };
}
