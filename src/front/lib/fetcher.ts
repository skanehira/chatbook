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

/**
 * The codes this client invents, as opposed to the ones the server sends.
 *
 * Exported because `ApiError.code` is a plain `string` — the wire has to stay
 * open to codes a newer server knows about — which means a caller comparing
 * against a typed-out literal gets no help when it drifts. The server pins its
 * own codes with `ERROR_CODES` + `satisfies`; this is the client's half.
 */
export const CLIENT_ERROR_CODES = {
  /** The response body is not this API's error envelope. */
  unknown: "UNKNOWN",
  /** A successful response does not match the caller's schema. */
  invalidResponse: "INVALID_RESPONSE",
  /** The request never produced a response at all. */
  network: "NETWORK_ERROR",
  /** The caller's own signal cut the request short. */
  aborted: "ABORTED",
} as const;

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

  // Read before the body: a refusal is worded in exactly one place, so the two
  // ways into this app (here, and the callers that read a response themselves)
  // cannot drift apart.
  if (!res.ok) throw await readRefusal(url, res);

  const body: unknown = await res.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      `unexpected response from ${url}`,
      CLIENT_ERROR_CODES.invalidResponse,
      res.status,
      "parse",
    );
  }

  return parsed.data;
}

/**
 * The refusal the server described, or the status when it described nothing.
 *
 * The single place a refusal is turned into words, for `fetcher` and for the
 * callers that read a response themselves — the chat stream and the PDF
 * binary, neither of which is JSON.
 */
export async function readRefusal(url: string, response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const envelope = errorEnvelopeSchema.safeParse(body);
  return envelope.success
    ? new ApiError(envelope.data.error.message, envelope.data.error.code, response.status)
    : new ApiError(
        `request to ${url} failed with status ${response.status}`,
        CLIENT_ERROR_CODES.unknown,
        response.status,
      );
}

/**
 * A rejection from `fetch` itself, given the shape every other failure has.
 *
 * Exported for the one caller that does not go through `fetcher` at all: the
 * chat stream reads the response body itself, and its failures have to be the
 * same `ApiError` the rest of the app reports.
 */
export function networkFailure(url: string, cause: unknown): ApiError {
  if ((cause instanceof DOMException || cause instanceof Error) && cause.name === "AbortError") {
    return new ApiError(cause.message, CLIENT_ERROR_CODES.aborted, 0, "network");
  }
  return new ApiError(
    `request to ${url} could not be sent`,
    CLIENT_ERROR_CODES.network,
    0,
    "network",
  );
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
