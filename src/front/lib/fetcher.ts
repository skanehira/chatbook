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
 * binary, neither of which is JSON, and `postWithProgress`, which has an
 * XMLHttpRequest's answer rather than a fetch's.
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

/**
 * The `XMLHttpRequest` plumbing `postWithProgress` and `putWithProgress`
 * share: open, send, and turn whatever came back into the same `ApiError`
 * shape every other request in this app produces. Only the method and the
 * event the browser reports progress on differ between the two.
 */
function xhrWithProgress<S extends z.ZodType>(
  method: "POST" | "PUT",
  url: string,
  schema: S,
  body: XMLHttpRequestBodyInit,
  onProgress: (loaded: number, total: number | null) => void,
  createRequest: () => XMLHttpRequest,
): ResultAsync<z.output<S>, ApiError> {
  const sent = new Promise<z.output<S>>((resolve, reject) => {
    const request = createRequest();
    request.open(method, url);

    request.upload.addEventListener("progress", (event) => {
      // `total` absent when the browser cannot say how big the body is; the
      // caller decides what to do with a share it cannot compute.
      onProgress(event.loaded, event.lengthComputable ? event.total : null);
    });

    request.addEventListener("load", () => {
      void (async () => {
        try {
          // Rebuilt as a Response so the refusal is worded in the same one
          // place every other request's is. A status outside 200–599 — which
          // is what a request the browser tore down arrives with — cannot be
          // one at all, so it is the same as never having got an answer.
          if (request.status < 200 || request.status > 599) {
            reject(networkFailure(url, null));
            return;
          }
          const answer = new Response(request.responseText, { status: request.status });
          if (!answer.ok) {
            reject(await readRefusal(url, answer));
            return;
          }
          const parsed = schema.safeParse(await answer.json().catch(() => null));
          if (!parsed.success) {
            reject(
              new ApiError(
                `unexpected response from ${url}`,
                CLIENT_ERROR_CODES.invalidResponse,
                request.status,
                "parse",
              ),
            );
            return;
          }
          resolve(parsed.data);
        } catch (cause) {
          // Nothing may throw out of here: this runs inside a listener, where
          // a rejection settles nothing, and the caller would wait forever on
          // a notice that never finishes.
          reject(cause instanceof ApiError ? cause : networkFailure(url, cause));
        }
      })();
    });

    request.addEventListener("error", () => reject(networkFailure(url, null)));
    request.addEventListener("abort", () =>
      reject(new ApiError("upload aborted", CLIENT_ERROR_CODES.aborted, 0, "network")),
    );

    request.send(body);
  });

  return ResultAsync.fromPromise(sent, (cause) =>
    cause instanceof ApiError ? cause : networkFailure(url, cause),
  );
}

/**
 * `resultFetcher` for the one request whose progress the reader has to see.
 *
 * `fetch` cannot report how much of a body has gone up, and a book is the one
 * thing this app sends that is large enough for that to matter: 22MB over a
 * phone's connection is a minute of a notice that never changes. So this one
 * goes through `XMLHttpRequest`, which can.
 *
 * Everything else is kept the same on purpose — the schema decides the return
 * type, and a refusal is worded by `readRefusal` — so a caller cannot tell this
 * apart from the rest except by the progress it reports.
 *
 * `createRequest` is injectable for the same reason `fetchFn` is elsewhere.
 */
export function postWithProgress<S extends z.ZodType>(
  url: string,
  schema: S,
  body: FormData,
  onProgress: (ratio: number) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): ResultAsync<z.output<S>, ApiError> {
  return xhrWithProgress(
    "POST",
    url,
    schema,
    body,
    (loaded, total) => {
      if (total !== null && total > 0) onProgress(loaded / total);
    },
    createRequest,
  );
}

/**
 * `xhrWithProgress` for one part of a larger upload: a chunk of a book too
 * big to send as a single request, PUT with the bytes it holds and how many
 * of them have gone up so far.
 *
 * `onProgress` gets raw bytes rather than a ratio — unlike `postWithProgress`,
 * this is one of several requests a caller is uploading together, and only
 * the caller knows the total across all of them.
 */
export function putWithProgress<S extends z.ZodType>(
  url: string,
  schema: S,
  body: Blob,
  onProgress: (loaded: number) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): ResultAsync<z.output<S>, ApiError> {
  return xhrWithProgress("PUT", url, schema, body, (loaded) => onProgress(loaded), createRequest);
}
