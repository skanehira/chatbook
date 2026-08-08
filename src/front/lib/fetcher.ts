import type { z } from "zod";
import { errorEnvelopeSchema } from "../../shared/schemas/error";

/**
 * A request the API refused, or answered with something this client cannot
 * read.
 */
export class ApiError extends Error {
  /** The server's `error.code`, or `"UNKNOWN"` when it did not send one. */
  readonly code: string;
  /** Status of the response the error was read from. */
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Code reported when the response body is not this API's error envelope. */
const UNKNOWN_ERROR_CODE = "UNKNOWN";

/** Code reported when a successful response does not match the caller's schema. */
const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

/**
 * Call the API and hand back a body that has been checked against `schema`.
 *
 * The schema is what makes the return type true: without it the caller's type
 * annotation is only a wish, since `res.json()` is `any`. Anything the schema
 * does not accept — including a refusal — leaves as an `ApiError`, so callers
 * have one error type to read `code` and `message` off.
 *
 * `fetchFn` is injectable so a caller that already owns a fetch (tests, or the
 * reader's own document loader) can pass it through.
 */
export async function fetcher<S extends z.ZodType>(
  url: string,
  schema: S,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<z.output<S>> {
  const res = await fetchFn(url, init);
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const failure = errorEnvelopeSchema.safeParse(body);
    if (failure.success) {
      throw new ApiError(failure.data.error.message, failure.data.error.code, res.status);
    }
    throw new ApiError(
      `request to ${url} failed with status ${res.status}`,
      UNKNOWN_ERROR_CODE,
      res.status,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(`unexpected response from ${url}`, INVALID_RESPONSE_CODE, res.status);
  }

  return parsed.data;
}
