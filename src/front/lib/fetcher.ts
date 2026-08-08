import { ResultAsync } from "neverthrow";
import type { z } from "zod";
import { errorEnvelopeSchema } from "../../shared/schemas/error";

/**
 * Where a request came apart, for callers that treat the three differently:
 * the server refused it (`http`), it never got a reply (`network`), or the
 * reply was not something this client can read (`parse`).
 */
export type ApiErrorKind = "http" | "network" | "parse";

/**
 * A request the API refused, or answered with something this client cannot
 * read.
 */
export class ApiError extends Error {
  /** The server's `error.code`, or `"UNKNOWN"` when it did not send one. */
  readonly code: string;
  /** Status of the response the error was read from, or 0 when there was none. */
  readonly status: number;
  /** Which of the three ways the request failed. */
  readonly kind: ApiErrorKind;

  constructor(message: string, code: string, status: number, kind: ApiErrorKind = "http") {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.kind = kind;
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
    throw new ApiError(
      `unexpected response from ${url}`,
      INVALID_RESPONSE_CODE,
      res.status,
      "parse",
    );
  }

  return parsed.data;
}

/** Code reported when the request never produced a response at all. */
const NETWORK_ERROR_CODE = "NETWORK_ERROR";

/** Code reported when the caller's own signal cut the request short. */
const ABORTED_CODE = "ABORTED";

/** A rejection from `fetch` itself, given the shape every other failure has. */
function networkFailure(url: string, cause: unknown): ApiError {
  if ((cause instanceof DOMException || cause instanceof Error) && cause.name === "AbortError") {
    return new ApiError(cause.message, ABORTED_CODE, 0, "network");
  }
  return new ApiError(`request to ${url} could not be sent`, NETWORK_ERROR_CODE, 0, "network");
}

/**
 * `fetcher` for the calls that are not reads: writes, and the one-off requests
 * an event handler makes.
 *
 * Those have no SWR above them holding an `error` state, so the failure has to
 * come back in the value or it is lost — which is how a highlight could fail to
 * save with nothing on screen to say so. Unlike `fetcher` this also covers the
 * request that never reached the server: a caller reading a `Result` has no
 * catch block for a stray `TypeError` to land in.
 */
export function resultFetcher<S extends z.ZodType>(
  url: string,
  schema: S,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch,
): ResultAsync<z.output<S>, ApiError> {
  return ResultAsync.fromPromise(fetcher(url, schema, init, fetchFn), (cause) =>
    cause instanceof ApiError ? cause : networkFailure(url, cause),
  );
}
