import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { pdfs, selections, chatMessages } from "../db/schema";
import {
  openPdf,
  getPdf,
  listPdfs,
  deletePdf,
  thumbnailObjectKey,
  THUMBNAIL_CONTENT_TYPE,
  systemIdClock,
  type IdClock,
} from "../services/pdfService";

import {
  buildSystemPrompt,
  streamChatCompletion,
  streamResponseWithWebSearch,
} from "../services/deepseekService";
import { buildMessages, findPageNumber, parseCitations } from "../services/chatService";
import { createSelectionRequestSchema } from "../../shared/schemas/selection";
import { sendChatRequestSchema } from "../../shared/schemas/chat";
import type { ErrorCode, ErrorPayload } from "../../shared/schemas/error";
import { validate } from "./validation";

type Env = {
  Bindings: {
    DB: D1Database;
    PDF_BUCKET: R2Bucket;
    DEEPSEEK_API_KEY: string;
  };
};

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
          return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid form body" } }, 400);
        }

        const file = formData.file;
        if (!file || !(file instanceof File)) {
          return c.json(
            { error: { code: "VALIDATION_ERROR", message: "No PDF file provided" } },
            400,
          );
        }

        // parseBody yields string | File per field; only strings are meaningful here
        const fullText = typeof formData.fullText === "string" ? formData.fullText : "";
        const pageCount =
          typeof formData.pageCount === "string" ? parseInt(formData.pageCount, 10) : 0;
        if (!fullText || !Number.isFinite(pageCount) || pageCount <= 0) {
          return c.json(
            { error: { code: "VALIDATION_ERROR", message: "Missing fullText or pageCount" } },
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

        try {
          const metadata = await openPdf(
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
          return c.json(metadata);
        } catch (err) {
          console.error("PDF open error:", err);
          return c.json(
            { error: { code: "PDF_EXTRACT_FAILED", message: "Failed to process PDF" } },
            500,
          );
        }
      })
      .get("/pdfs", async (c) => {
        const books = await listPdfs(c.env.DB, c.env.PDF_BUCKET);
        return c.json({ books });
      })
      .get("/pdf/:pdfId/thumbnail", async (c) => {
        const pdf = await drizzle(c.env.DB)
          .select({ fileHash: pdfs.fileHash })
          .from(pdfs)
          .where(eq(pdfs.id, c.req.param("pdfId")))
          .get();
        if (!pdf) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }

        const object = await c.env.PDF_BUCKET.get(thumbnailObjectKey(pdf.fileHash));
        if (!object) {
          return c.json(
            { error: { code: "THUMBNAIL_MISSING", message: "No cover stored for this book" } },
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
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }

        const body = await c.req.arrayBuffer();
        if (body.byteLength === 0) {
          return c.json({ error: { code: "VALIDATION_ERROR", message: "Empty thumbnail" } }, 400);
        }

        await c.env.PDF_BUCKET.put(thumbnailObjectKey(pdf.fileHash), body, {
          httpMetadata: { contentType: THUMBNAIL_CONTENT_TYPE },
        });

        return c.json({ stored: true });
      })
      .get("/pdf/:pdfId/file", async (c) => {
        const pdfId = c.req.param("pdfId");
        const d1Db = drizzle(c.env.DB);
        const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
        if (!pdf) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }

        const object = await c.env.PDF_BUCKET.get(pdf.filePath);
        if (!object) {
          return c.json(
            { error: { code: "PDF_FILE_MISSING", message: "PDF binary not found in storage" } },
            404,
          );
        }

        return new Response(object.body, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${encodeURIComponent(pdf.fileName)}"`,
          },
        });
      })
      // Resolves a passage from a `#:~:text=` link to the page that holds it. The
      // browser cannot do this itself here: the page is only in the DOM once the
      // reader has jumped to it.
      .get("/pdf/:pdfId/locate", async (c) => {
        const text = c.req.query("text");
        const pdf = await drizzle(c.env.DB)
          .select({ fullText: pdfs.fullText, pageCount: pdfs.pageCount })
          .from(pdfs)
          .where(eq(pdfs.id, c.req.param("pdfId")))
          .get();
        if (!pdf) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }
        if (!text) {
          return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing text" } }, 400);
        }

        return c.json({ pageNumber: findPageNumber(text, pdf.fullText, pdf.pageCount) ?? null });
      })
      .get("/pdf/:pdfId", async (c) => {
        const pdfId = c.req.param("pdfId");
        const result = await getPdf(c.env.DB, c.env.PDF_BUCKET, pdfId);

        if (!result) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }

        return c.json(result);
      })
      .post("/pdf/:pdfId/selections", validate("json", createSelectionRequestSchema), async (c) => {
        const pdfId = c.req.param("pdfId");
        const d1Db = drizzle(c.env.DB);

        // Verify pdf exists
        const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
        if (!pdf) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
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
            { error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" } },
            404,
          );
        }

        const messages = await d1Db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.selectionId, selId))
          .all();

        return c.json({
          selectionId: selId,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            citations: m.citations ? JSON.parse(m.citations) : null,
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
          const apiKey = c.env.DEEPSEEK_API_KEY;

          if (!apiKey) {
            return c.json(
              { error: { code: "CONFIG_ERROR", message: "DEEPSEEK_API_KEY not set" } },
              500,
            );
          }

          const sel = await d1Db.select().from(selections).where(eq(selections.id, selId)).get();
          if (!sel) {
            return c.json(
              { error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" } },
              404,
            );
          }

          // useWebSearch takes a real boolean only: it used to be coerced with
          // `!!`, so the string "false" turned web search on.
          const { content, useWebSearch } = c.req.valid("json");

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
            .select({ fullText: pdfs.fullText, pageCount: pdfs.pageCount })
            .from(pdfs)
            .where(eq(pdfs.id, sel.pdfId))
            .get();

          if (!pdfRow) {
            return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
          }

          // Get chat history
          const history = await d1Db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.selectionId, selId))
            .all();

          // Build system prompt
          const fullText = pdfRow.fullText;
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
                async onDone(usage: { inputTokens: number; outputTokens: number }) {
                  // Parse citations with page number lookup for PDF citations
                  const citations = parseCitations(fullResponse, fullText, pdfRow.pageCount);

                  // Save the answer before telling the client about it, so a client
                  // that already left cannot stop the save
                  const assistantMsgId = idClock.newId();
                  await d1Db
                    .insert(chatMessages)
                    .values({
                      id: assistantMsgId,
                      selectionId: selId,
                      role: "assistant",
                      content: fullResponse,
                      citations: JSON.stringify(citations),
                      createdAt: idClock.now(),
                    })
                    .run()
                    .catch((err: Error) => console.error("Failed to save assistant message:", err));

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
                  if (useWebSearch) {
                    await streamResponseWithWebSearch(apiKey, systemPrompt, content, callbacks);
                  } else {
                    const messages = buildMessages(
                      systemPrompt,
                      history.map((h) => ({ role: h.role, content: h.content })),
                      content,
                    );
                    await streamChatCompletion(apiKey, messages, callbacks);
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
        const deleted = await deletePdf(c.env.DB, c.env.PDF_BUCKET, c.req.param("pdfId"));
        if (!deleted) {
          return c.json({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404);
        }

        return c.json({ deleted: true });
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
