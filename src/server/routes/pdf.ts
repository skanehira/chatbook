import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { ResultAsync } from "neverthrow";
import { pdfs, selections, chatMessages } from "../db/schema";
import {
  openPdf,
  openStoredPdf,
  getPdf,
  listPdfs,
  deletePdf,
  fullTextObjectKey,
  pdfObjectKey,
  readPdfFullText,
  saveReadingState,
  searchSelections,
  thumbnailObjectKey,
  THUMBNAIL_CONTENT_TYPE,
  systemIdClock,
  type IdClock,
} from "../services/pdfService";

import {
  buildSystemPrompt,
  resolveLlmConfig,
  streamChatCompletion,
  streamResponseWithWebSearch,
  type StreamUsage,
} from "../services/llmService";
import {
  buildConversation,
  findPageNumber,
  parseCitations,
  readCitations,
} from "../services/chatService";
import { locateQuerySchema, saveReadingStateRequestSchema } from "../../shared/schemas/book";
import {
  createSelectionRequestSchema,
  selectionSearchQuerySchema,
} from "../../shared/schemas/selection";
import { sendChatRequestSchema } from "../../shared/schemas/chat";
import type { ErrorCode, ErrorPayload } from "../../shared/schemas/error";
import {
  fileHashSchema,
  uploadInitRequestSchema,
  uploadCompleteRequestSchema,
} from "../../shared/schemas/upload";
import { storageFailure, type ServiceError } from "../services/serviceError";
import { validate } from "./validation";

type Env = {
  Bindings: {
    DB: D1Database;
    PDF_BUCKET: R2Bucket;
    LLM_API_KEY: string;
    // Optional because a deploy that names no provider gets DeepSeek, which is
    // where every deploy that predates these settings already points.
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    LLM_WEB_SEARCH_SUPPORTED?: string;
  };
};

/** A cover is one page rendered 400px wide; nothing that big is one. */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** What every endpoint says about a book id that is not on the shelf. */
const PDF_NOT_FOUND = {
  code: "PDF_NOT_FOUND" satisfies ErrorCode,
  message: "PDF not found",
} as const;

/**
 * A book's worth of extracted text, even at a thousand pages, is a few MB —
 * nowhere near what the PDF binary can reach. So only the binary needs R2's
 * multipart upload; the text goes up as one PUT, and this is generous
 * headroom for it rather than a limit anyone should expect to approach.
 */
const MAX_FULL_TEXT_BYTES = 20 * 1024 * 1024;

function responseRange(object: R2Object): { contentRange: string; contentLength: number } | null {
  const range = object.range;
  if (!range || !("offset" in range) || typeof range.offset !== "number") return null;

  const length = range.length ?? object.size - range.offset;
  return {
    contentRange: `bytes ${range.offset}-${range.offset + length - 1}/${object.size}`,
    contentLength: length,
  };
}

/**
 * The reply a store that refused to answer turns into.
 *
 * The cause never leaves the server, but it does reach its log: a 500 nobody
 * can explain is worse than the plain-text one this replaced.
 */
function storageFailureResponse(c: Context<Env>, cause: unknown) {
  console.error("Storage failure:", cause);
  return c.json(
    { error: { code: "INTERNAL_ERROR" satisfies ErrorCode, message: "Unexpected server error" } },
    500,
  );
}

/**
 * The reply a failed service call turns into.
 *
 * The two cases a service reports map onto the two a client can act on: the
 * thing is not there (404, in the endpoint's own words), or the store refused
 * and nobody can do anything but try again (500).
 */
function serviceFailureResponse(
  c: Context<Env>,
  failure: ServiceError,
  missing: { code: ErrorCode; message: string },
) {
  return failure.type === "NOT_FOUND"
    ? c.json({ error: missing }, 404)
    : storageFailureResponse(c, failure.cause);
}

/** A WebP file is a RIFF container whose form type, at offset 8, is "WEBP". */
function isWebp(body: ArrayBuffer): boolean {
  if (body.byteLength < 12) return false;
  const header = new Uint8Array(body, 0, 12);
  const tag = (offset: number) => String.fromCharCode(...header.subarray(offset, offset + 4));
  return tag(0) === "RIFF" && tag(8) === "WEBP";
}

/**
 * Build the PDF routes. Ids and timestamps come from the injected clock; the
 * exported pdfRoute uses the system clock. Passing a fixed clock here makes a
 * request's writes deterministic.
 */
export function createPdfRoute(idClock: IdClock = systemIdClock) {
  return (
    new Hono<Env>()
      .post("/pdf/open", async (c) => {
        const formData = await c.req.parseBody().catch(() => null);
        if (!formData) {
          return c.json(
            {
              error: { code: "VALIDATION_ERROR" satisfies ErrorCode, message: "Invalid form body" },
            },
            400,
          );
        }

        const file = formData.file;
        if (!file || !(file instanceof File)) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: "No PDF file provided",
              },
            },
            400,
          );
        }

        // parseBody yields string | File per field; only strings are meaningful here
        const fullText = typeof formData.fullText === "string" ? formData.fullText : "";
        const pageCount =
          typeof formData.pageCount === "string" ? parseInt(formData.pageCount, 10) : 0;
        if (!fullText || !Number.isFinite(pageCount) || pageCount <= 0) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: "Missing fullText or pageCount",
              },
            },
            400,
          );
        }

        // Compute hash and get binary data
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
        const fileHash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const thumbnailField = formData.thumbnail;
        const thumbnail =
          thumbnailField instanceof File ? await thumbnailField.arrayBuffer() : undefined;

        const stored = await openPdf(
          c.env.DB,
          c.env.PDF_BUCKET,
          {
            fileName: file.name,
            fileHash,
            fullText,
            pageCount,
            arrayBuffer,
            thumbnail,
          },
          idClock,
        );

        return stored.match(
          (metadata) => c.json(metadata),
          (failure) => {
            console.error("PDF open error:", failure.cause);
            return c.json(
              {
                error: {
                  code: "PDF_EXTRACT_FAILED" satisfies ErrorCode,
                  message: "Failed to process PDF",
                },
              },
              500,
            );
          },
        );
      })
      .post("/pdf/uploads/init", validate("json", uploadInitRequestSchema), async (c) => {
        const { fileHash } = c.req.valid("json");
        const pdfUpload = await c.env.PDF_BUCKET.createMultipartUpload(pdfObjectKey(fileHash), {
          httpMetadata: { contentType: "application/pdf" },
        });

        return c.json({ pdfUploadId: pdfUpload.uploadId });
      })
      .put("/pdf/uploads/:fileHash/:uploadId/parts/:partNumber", async (c) => {
        const fileHash = fileHashSchema.safeParse(c.req.param("fileHash"));
        const partNumber = Number(c.req.param("partNumber"));
        if (!fileHash.success || !Number.isInteger(partNumber) || partNumber <= 0) {
          return c.json(
            {
              error: { code: "VALIDATION_ERROR" satisfies ErrorCode, message: "Invalid upload" },
            },
            400,
          );
        }

        const upload = c.env.PDF_BUCKET.resumeMultipartUpload(
          pdfObjectKey(fileHash.data),
          c.req.param("uploadId"),
        );
        const part = await upload.uploadPart(partNumber, await c.req.arrayBuffer());
        return c.json({ partNumber: part.partNumber, etag: part.etag });
      })
      // The text is small enough to go up as one PUT rather than through R2's
      // multipart dance; this has to land before `/uploads/complete`, which
      // just points the new row at the key this wrote.
      .put("/pdf/uploads/:fileHash/text", async (c) => {
        const fileHash = fileHashSchema.safeParse(c.req.param("fileHash"));
        if (!fileHash.success) {
          return c.json(
            {
              error: { code: "VALIDATION_ERROR" satisfies ErrorCode, message: "Invalid upload" },
            },
            400,
          );
        }

        const body = await c.req.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > MAX_FULL_TEXT_BYTES) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: `Text must be non-empty and at most ${MAX_FULL_TEXT_BYTES} bytes`,
              },
            },
            400,
          );
        }

        await c.env.PDF_BUCKET.put(fullTextObjectKey(fileHash.data), body, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });

        return c.json({ stored: true });
      })
      .post("/pdf/uploads/complete", validate("json", uploadCompleteRequestSchema), async (c) => {
        const { fileName, fileHash, pageCount, pdfUploadId, pdfParts } = c.req.valid("json");

        const pdfUpload = c.env.PDF_BUCKET.resumeMultipartUpload(
          pdfObjectKey(fileHash),
          pdfUploadId,
        );
        await pdfUpload.complete(pdfParts);

        const stored = await openStoredPdf(c.env.DB, { fileName, fileHash, pageCount }, idClock);

        return stored.match(
          (metadata) => c.json(metadata),
          (failure) => {
            console.error("PDF multipart open error:", failure.cause);
            return c.json(
              {
                error: {
                  code: "PDF_EXTRACT_FAILED" satisfies ErrorCode,
                  message: "Failed to process PDF",
                },
              },
              500,
            );
          },
        );
      })
      .get("/pdfs", async (c) => {
        const shelf = await listPdfs(c.env.DB, c.env.PDF_BUCKET);
        return shelf.match(
          (books) => c.json({ books }),
          (failure) => storageFailureResponse(c, failure.cause),
        );
      })
      .get("/pdf/:pdfId/thumbnail", async (c) => {
        const pdf = await drizzle(c.env.DB)
          .select({ fileHash: pdfs.fileHash })
          .from(pdfs)
          .where(eq(pdfs.id, c.req.param("pdfId")))
          .get();
        if (!pdf) {
          return c.json(
            { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
            404,
          );
        }

        const object = await c.env.PDF_BUCKET.get(thumbnailObjectKey(pdf.fileHash));
        if (!object) {
          return c.json(
            {
              error: {
                code: "THUMBNAIL_MISSING" satisfies ErrorCode,
                message: "No cover stored for this book",
              },
            },
            404,
          );
        }

        return new Response(object.body, {
          headers: {
            "Content-Type": THUMBNAIL_CONTENT_TYPE,
            "Cache-Control": "no-cache",
          },
        });
      })
      .put("/pdf/:pdfId/thumbnail", async (c) => {
        const pdf = await drizzle(c.env.DB)
          .select({ fileHash: pdfs.fileHash })
          .from(pdfs)
          .where(eq(pdfs.id, c.req.param("pdfId")))
          .get();
        if (!pdf) {
          return c.json(
            { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
            404,
          );
        }

        if (c.req.header("Content-Type") !== THUMBNAIL_CONTENT_TYPE) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: `Thumbnail must be sent as ${THUMBNAIL_CONTENT_TYPE}`,
              },
            },
            400,
          );
        }

        const body = await c.req.arrayBuffer();
        if (body.byteLength === 0) {
          return c.json(
            { error: { code: "VALIDATION_ERROR" satisfies ErrorCode, message: "Empty thumbnail" } },
            400,
          );
        }
        if (body.byteLength > MAX_THUMBNAIL_BYTES) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: `Thumbnail is larger than ${MAX_THUMBNAIL_BYTES} bytes`,
              },
            },
            400,
          );
        }
        // The bucket serves this back as image/webp, so what goes in has to be
        // one: the endpoint is otherwise a way to store arbitrary bytes.
        if (!isWebp(body)) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR" satisfies ErrorCode,
                message: "Thumbnail is not a WebP image",
              },
            },
            400,
          );
        }

        await c.env.PDF_BUCKET.put(thumbnailObjectKey(pdf.fileHash), body, {
          httpMetadata: { contentType: THUMBNAIL_CONTENT_TYPE },
        });

        return c.json({ stored: true });
      })
      .get("/pdf/:pdfId/file", async (c) => {
        const pdfId = c.req.param("pdfId");
        const d1Db = drizzle(c.env.DB);
        // Only the two columns this answer is built from. Selecting the row
        // whole would read `full_text` as well — hundreds of kilobytes on a
        // real book, fetched out of D1 on every open just to be discarded.
        const pdf = await d1Db
          .select({ filePath: pdfs.filePath, fileName: pdfs.fileName })
          .from(pdfs)
          .where(eq(pdfs.id, pdfId))
          .get();
        if (!pdf) {
          return c.json(
            { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
            404,
          );
        }

        // `onlyIf` hands the browser's `If-None-Match` to R2, which answers
        // without the body when the file is the one already held. Reading the
        // header here instead would still pull the object out of storage.
        const object = await c.env.PDF_BUCKET.get(pdf.filePath, {
          onlyIf: c.req.raw.headers,
          range: c.req.raw.headers,
        });
        if (!object) {
          return c.json(
            {
              error: {
                code: "PDF_FILE_MISSING" satisfies ErrorCode,
                message: "PDF binary not found in storage",
              },
            },
            404,
          );
        }

        // A book is stored under the hash of its own bytes, so what a given id
        // points at never changes: the browser can keep it and stop asking.
        // `private` because this is behind the session — a shared cache holding
        // it would hand the book to whoever asked next.
        const headers = {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${encodeURIComponent(pdf.fileName)}"`,
          "Cache-Control": "private, max-age=31536000, immutable",
          "Accept-Ranges": "bytes",
          ETag: object.httpEtag,
        };

        // R2 leaves the body off when the condition said the file is unchanged
        if (!("body" in object)) return new Response(null, { status: 304, headers });

        // R2 fills in `object.range` (offset 0, full length) even when the
        // request carried no `Range` header, so its mere presence cannot be
        // used to decide 206 vs 200 — the request header is the only signal.
        const range = c.req.raw.headers.has("Range") ? responseRange(object) : null;
        return new Response(object.body, {
          status: range ? 206 : 200,
          headers: {
            ...headers,
            "Content-Length": String(range?.contentLength ?? object.size),
            ...(range ? { "Content-Range": range.contentRange } : {}),
          },
        });
      })
      // Narrows the highlight list by what was marked and what was said about
      // it. The chats are not in the book the list was drawn from, so this is
      // the only place both can be looked through at once.
      .get("/pdf/:pdfId/search", validate("query", selectionSearchQuerySchema), async (c) => {
        const found = await searchSelections(
          c.env.DB,
          c.req.param("pdfId"),
          c.req.valid("query").q,
        );

        return found.match(
          (selectionIds) => c.json({ selectionIds }),
          (failure) => serviceFailureResponse(c, failure, PDF_NOT_FOUND),
        );
      })
      // Resolves a passage from a `#:~:text=` link to the page that holds it. The
      // browser cannot do this itself here: the page is only in the DOM once the
      // reader has jumped to it.
      .get("/pdf/:pdfId/locate", validate("query", locateQuerySchema), async (c) => {
        const { text } = c.req.valid("query");
        const pdf = await drizzle(c.env.DB)
          .select({
            fullText: pdfs.fullText,
            fullTextPath: pdfs.fullTextPath,
            pageCount: pdfs.pageCount,
          })
          .from(pdfs)
          .where(eq(pdfs.id, c.req.param("pdfId")))
          .get();
        if (!pdf) {
          return c.json(
            { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
            404,
          );
        }

        return c.json(
          findPageNumber(text, await readPdfFullText(c.env.PDF_BUCKET, pdf), pdf.pageCount),
        );
      })
      // Where the reader is, kept on the server so the book opens there on
      // whichever device is picked up next. Read back as part of the book itself.
      .put(
        "/pdf/:pdfId/reading-state",
        validate("json", saveReadingStateRequestSchema),
        async (c) => {
          const saved = await saveReadingState(c.env.DB, c.req.param("pdfId"), c.req.valid("json"));

          return saved.match(
            () => c.json({ saved: true }),
            (failure) => serviceFailureResponse(c, failure, PDF_NOT_FOUND),
          );
        },
      )
      .get("/pdf/:pdfId", async (c) => {
        const book = await getPdf(c.env.DB, c.env.PDF_BUCKET, c.req.param("pdfId"));

        return book.match(
          (found) => c.json(found),
          (failure) => serviceFailureResponse(c, failure, PDF_NOT_FOUND),
        );
      })
      .post("/pdf/:pdfId/selections", validate("json", createSelectionRequestSchema), async (c) => {
        const pdfId = c.req.param("pdfId");
        const d1Db = drizzle(c.env.DB);

        // Verify pdf exists
        const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
        if (!pdf) {
          return c.json(
            { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
            404,
          );
        }

        // Validated, so positionData is already down to the shape the viewer
        // draws from: the measurement's other fields are stripped here rather
        // than stored and read back as an unknown blob.
        const { selectedText, pageNumber, positionData } = c.req.valid("json");

        const id = idClock.newId();
        const now = idClock.now();
        await d1Db.insert(selections).values({
          id,
          pdfId,
          selectedText,
          pageNumber,
          positionData: JSON.stringify(positionData),
          createdAt: now,
        });

        return c.json({ id, selectedText, pageNumber, positionData, createdAt: now }, 201);
      })
      .get("/pdf/:pdfId/selections/:selId/chats", async (c) => {
        const selId = c.req.param("selId");
        const d1Db = drizzle(c.env.DB);

        const sel = await d1Db.select().from(selections).where(eq(selections.id, selId)).get();
        if (!sel) {
          return c.json(
            {
              error: {
                code: "SELECTION_NOT_FOUND" satisfies ErrorCode,
                message: "Selection not found",
              },
            },
            404,
          );
        }

        const messages = await d1Db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.selectionId, selId))
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
          .all();

        return c.json({
          selectionId: selId,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            citations: readCitations(m.citations),
            createdAt: m.createdAt,
          })),
        });
      })
      .post(
        "/pdf/:pdfId/selections/:selId/chats",
        validate("json", sendChatRequestSchema),
        async (c) => {
          const selId = c.req.param("selId");
          const d1Db = drizzle(c.env.DB);
          const llmConfig = resolveLlmConfig(c.env);

          if (!llmConfig.apiKey) {
            return c.json(
              {
                error: {
                  code: "CONFIG_ERROR" satisfies ErrorCode,
                  message: "LLM_API_KEY not set",
                },
              },
              500,
            );
          }

          const sel = await d1Db.select().from(selections).where(eq(selections.id, selId)).get();
          if (!sel) {
            return c.json(
              {
                error: {
                  code: "SELECTION_NOT_FOUND" satisfies ErrorCode,
                  message: "Selection not found",
                },
              },
              404,
            );
          }

          // useWebSearch takes a real boolean only: it used to be coerced with
          // `!!`, so the string "false" turned web search on.
          const { content, useWebSearch: readerWantsWebSearch } = c.req.valid("json");

          // The reader's switch is remembered in their own browser, so it
          // outlives a deploy pointed at a provider with no Responses API. The
          // provider has the final say; the menu hides the switch as well
          // (`GET /api/config`), but this is what keeps a stale one harmless.
          const useWebSearch = readerWantsWebSearch && llmConfig.webSearchSupported;

          // Read the history before saving the question, so it holds only the
          // earlier turns: `buildConversation` appends this question itself, and
          // reading afterwards would hand the model the same question twice.
          const history = await d1Db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.selectionId, selId))
            .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
            .all();

          // Save user message
          const userMsgId = idClock.newId();
          const now = idClock.now();
          await d1Db.insert(chatMessages).values({
            id: userMsgId,
            selectionId: selId,
            role: "user",
            content,
            createdAt: now,
          });

          // Get PDF text for context
          const pdfRow = await d1Db
            .select({
              fullText: pdfs.fullText,
              fullTextPath: pdfs.fullTextPath,
              pageCount: pdfs.pageCount,
            })
            .from(pdfs)
            .where(eq(pdfs.id, sel.pdfId))
            .get();

          if (!pdfRow) {
            return c.json(
              { error: { code: "PDF_NOT_FOUND" satisfies ErrorCode, message: "PDF not found" } },
              404,
            );
          }

          // Build system prompt
          const fullText = await readPdfFullText(c.env.PDF_BUCKET, pdfRow);
          const systemPrompt = buildSystemPrompt(fullText, sel.selectedText, useWebSearch);

          // Set up SSE streaming
          const encoder = new TextEncoder();
          let fullResponse = "";
          // Leaving the chat cancels the response body. That only means "stop
          // sending"; the answer is still read to the end and saved below, so
          // reopening the highlight shows it.
          let clientGone = false;
          let finished!: Promise<void>;

          const stream = new ReadableStream({
            start(controller) {
              // Writing to a cancelled stream is allowed to throw, and a throw here
              // would escape into the AI service's own catch and lose the answer
              // before it is saved. Swallowing it is what keeps the save reachable.
              const send = (payload: string) => {
                if (clientGone) return;
                try {
                  controller.enqueue(encoder.encode(payload));
                } catch {
                  // A cancel can beat its own handler, so a refused write means the
                  // client is gone too
                  clientGone = true;
                }
              };
              const closeStream = () => {
                if (clientGone) return;
                try {
                  controller.close();
                } catch {
                  clientGone = true;
                }
              };

              const callbacks = {
                onToken(token: string) {
                  fullResponse += token;
                  send(`event: token\ndata: ${JSON.stringify({ content: token })}\n\n`);
                },
                async onDone(usage: StreamUsage) {
                  // Parse citations with page number lookup for PDF citations
                  const citations = parseCitations(fullResponse, fullText, pdfRow.pageCount);

                  // Save the answer before telling the client about it, so a client
                  // that already left cannot stop the save
                  const assistantMsgId = idClock.newId();
                  const saved = await ResultAsync.fromPromise(
                    d1Db
                      .insert(chatMessages)
                      .values({
                        id: assistantMsgId,
                        selectionId: selId,
                        role: "assistant",
                        content: fullResponse,
                        citations: JSON.stringify(citations),
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cachedInputTokens: usage.cachedInputTokens,
                        createdAt: idClock.now(),
                      })
                      .run(),
                    storageFailure,
                  );

                  // An answer that was not stored is gone the moment the chat is
                  // reopened. Sending `done` for it would show the reader a
                  // finished conversation that empties itself on the next visit.
                  if (saved.isErr()) {
                    console.error("Failed to save assistant message:", saved.error.cause);
                    send(
                      `event: error\ndata: ${JSON.stringify({
                        code: "CHAT_SAVE_FAILED" satisfies ErrorCode,
                        message: "The answer could not be saved",
                      } satisfies ErrorPayload)}\n\n`,
                    );
                    closeStream();
                    return;
                  }

                  for (const citation of citations) {
                    send(`event: citation\ndata: ${JSON.stringify(citation)}\n\n`);
                  }
                  send(
                    `event: done\ndata: ${JSON.stringify({ messageId: assistantMsgId, usage })}\n\n`,
                  );
                  closeStream();
                },
                onError(err: Error) {
                  send(
                    `event: error\ndata: ${JSON.stringify({
                      code: "AI_API_ERROR" satisfies ErrorCode,
                      message: err.message,
                    } satisfies ErrorPayload)}\n\n`,
                  );
                  closeStream();
                },
              };

              finished = (async () => {
                try {
                  // Both endpoints get the same conversation; they differ only
                  // in where the system prompt rides (`instructions` vs a turn)
                  const conversation = buildConversation(
                    history.map((h) => ({ role: h.role, content: h.content })),
                    content,
                  );
                  if (useWebSearch) {
                    await streamResponseWithWebSearch(
                      llmConfig,
                      systemPrompt,
                      conversation,
                      callbacks,
                    );
                  } else {
                    await streamChatCompletion(
                      llmConfig,
                      [{ role: "system", content: systemPrompt }, ...conversation],
                      callbacks,
                    );
                  }
                } catch (err) {
                  send(
                    `event: error\ndata: ${JSON.stringify({
                      code: "AI_STREAM_ERROR" satisfies ErrorCode,
                      message: String(err),
                    } satisfies ErrorPayload)}\n\n`,
                  );
                  closeStream();
                }
              })();
            },
            cancel() {
              clientGone = true;
            },
          });

          // The save has to outlive the request the client just walked away from
          c.executionCtx.waitUntil(finished);

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        },
      )
      .delete("/pdf/:pdfId", async (c) => {
        const removal = await deletePdf(c.env.DB, c.env.PDF_BUCKET, c.req.param("pdfId"));

        return removal.match(
          () => c.json({ deleted: true }),
          (failure) => serviceFailureResponse(c, failure, PDF_NOT_FOUND),
        );
      })
      .delete("/pdf/:pdfId/selections/:selId", async (c) => {
        const selId = c.req.param("selId");
        const d1Db = drizzle(c.env.DB);

        await d1Db.delete(selections).where(eq(selections.id, selId));
        return c.json({ deleted: true });
      })
  );
}

export const pdfRoute = createPdfRoute();
