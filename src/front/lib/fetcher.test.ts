import { describe, it, expect } from "vite-plus/test";
import { z } from "zod";
import { ApiError, fetcher, resultFetcher } from "./fetcher";

const bookSchema = z.object({ id: z.string(), pageCount: z.number().int().positive() });

/** A fetch that always answers with the given body and status. */
function respondingWith(body: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

describe("fetcher", () => {
  it("returns the body when it matches the schema", async () => {
    const book = await fetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ id: "b1", pageCount: 209 }),
    );

    expect(book).toStrictEqual({ id: "b1", pageCount: 209 });
  });

  it("carries the server's own code and message when the request is refused", async () => {
    const failed = fetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404),
    );

    await expect(failed).rejects.toThrow(ApiError);
    const error = (await failed.catch((err: ApiError) => err)) as ApiError;
    expect([error.message, error.code, error.status]).toStrictEqual([
      "PDF not found",
      "PDF_NOT_FOUND",
      404,
    ]);
  });

  it("falls back to the status when the refusal is not the API's error envelope", async () => {
    const failed = fetcher("/api/pdf/b1", bookSchema, undefined, respondingWith("<html>", 502));

    const error = (await failed.catch((err: ApiError) => err)) as ApiError;
    expect([error.message, error.code, error.status]).toStrictEqual([
      "request to /api/pdf/b1 failed with status 502",
      "UNKNOWN",
      502,
    ]);
  });

  it("lets a request that never reached the server through as the failure fetch reported", async () => {
    // Only failures the server described are ApiError. A connection that never
    // produced a response has no code or status to report, and callers that
    // handle an abort look at the original error's name.
    const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

    const failed = fetcher("/api/pdf/b1", bookSchema, undefined, offline);

    const error = (await failed.catch((err: unknown) => err)) as TypeError;
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toBe("Failed to fetch");
  });

  it("lets an aborted request through with the name callers check for", async () => {
    const aborted: typeof fetch = () =>
      Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

    const failed = fetcher("/api/pdf/b1", bookSchema, undefined, aborted);

    const error = (await failed.catch((err: unknown) => err)) as DOMException;
    expect([error.name, error.message]).toStrictEqual(["AbortError", "The operation was aborted."]);
  });

  it("refuses a successful response whose body is not what the caller asked for", async () => {
    // Without this the caller's type annotation is a wish: the old fetcher
    // handed the body straight on, so pageCount could be a string at runtime.
    const failed = fetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ id: "b1", pageCount: "209" }),
    );

    const error = (await failed.catch((err: ApiError) => err)) as ApiError;
    expect([error.message, error.code, error.status]).toStrictEqual([
      "unexpected response from /api/pdf/b1",
      "INVALID_RESPONSE",
      200,
    ]);
  });
});

/** The four facts a caller reads off a failure, in one comparable value. */
function failureOf(error: ApiError): [string, string, number, string] {
  return [error.message, error.code, error.status, error.kind];
}

describe("resultFetcher", () => {
  it("hands back the checked body as an Ok when the request succeeds", async () => {
    const result = await resultFetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ id: "b1", pageCount: 209 }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ id: "b1", pageCount: 209 });
  });

  it("reports a refusal as an Err carrying the server's own code", async () => {
    const result = await resultFetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404),
    );

    expect(failureOf(result._unsafeUnwrapErr())).toStrictEqual([
      "PDF not found",
      "PDF_NOT_FOUND",
      404,
      "http",
    ]);
  });

  it("reports a body that does not match the schema as a parse failure", async () => {
    const result = await resultFetcher(
      "/api/pdf/b1",
      bookSchema,
      undefined,
      respondingWith({ id: "b1", pageCount: "209" }),
    );

    expect(failureOf(result._unsafeUnwrapErr())).toStrictEqual([
      "unexpected response from /api/pdf/b1",
      "INVALID_RESPONSE",
      200,
      "parse",
    ]);
  });

  it("reports a request that never reached the server as a network failure", async () => {
    // This is where resultFetcher parts company with fetcher: a mutation has
    // nobody above it to catch a raw TypeError, so the offline case has to
    // arrive as the same ApiError every other failure does.
    const offline: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

    const result = await resultFetcher("/api/pdf/b1", bookSchema, undefined, offline);

    expect(failureOf(result._unsafeUnwrapErr())).toStrictEqual([
      "request to /api/pdf/b1 could not be sent",
      "NETWORK_ERROR",
      0,
      "network",
    ]);
  });

  it("reports an aborted request under a code the caller can single out", async () => {
    const aborted: typeof fetch = () =>
      Promise.reject(new DOMException("The operation was aborted.", "AbortError"));

    const result = await resultFetcher("/api/pdf/b1", bookSchema, undefined, aborted);

    expect(failureOf(result._unsafeUnwrapErr())).toStrictEqual([
      "The operation was aborted.",
      "ABORTED",
      0,
      "network",
    ]);
  });
});
