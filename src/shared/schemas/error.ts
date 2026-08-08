import { z } from "zod";

/**
 * Every reason the API refuses or fails a request. Producers pin themselves to
 * this union with `satisfies`, so a typo in a thrown code is a build error.
 */
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "PDF_NOT_FOUND",
  "PDF_FILE_MISSING",
  "PDF_EXTRACT_FAILED",
  "THUMBNAIL_MISSING",
  "SELECTION_NOT_FOUND",
  "CONFIG_ERROR",
  "AI_API_ERROR",
  "AI_STREAM_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The body of a failure, in both transports it travels over: a JSON response
 * with a 4xx/5xx status, and an `event: error` block of the chat stream.
 *
 * `code` stays `z.string()` on the wire on purpose — a reader must survive a
 * code a newer server added, and the reader has nothing useful to do with an
 * unknown one beyond passing it on.
 */
export const errorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/** How a failure is wrapped when it travels as an HTTP response body. */
export const errorEnvelopeSchema = z.object({
  error: errorPayloadSchema,
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
