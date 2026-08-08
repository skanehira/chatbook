import { describe, it, expect } from "vite-plus/test";
import { z } from "zod";
import { ApiError, fetcher } from "./fetcher";

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
