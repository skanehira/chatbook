import { describe, it, expect, beforeAll } from "vite-plus/test";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { apiFetch } from "./setup/session";
import { SESSION_COOKIE, issueSession } from "../../src/server/auth/session";
import { MINIMAL_PDF_BYTES } from "./fixtures/minimalPdf";
import app from "../../src/server/index";
import {
  openPdf,
  pdfObjectKey,
  thumbnailObjectKey,
  type IdClock,
} from "../../src/server/services/pdfService";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * PDFs are de-duplicated by content hash, so tests that need their own book
 * must upload distinct bytes. Appending a PDF comment keeps the file valid.
 */
function uniquePdfBytes(tag: string): Uint8Array {
  const suffix = new TextEncoder().encode(`\n%${tag}\n`);
  const bytes = new Uint8Array(MINIMAL_PDF_BYTES.length + suffix.length);
  bytes.set(MINIMAL_PDF_BYTES, 0);
  bytes.set(suffix, MINIMAL_PDF_BYTES.length);
  return bytes;
}

async function uploadBook(options: {
  tag: string;
  fileName: string;
  thumbnail?: Blob;
  /** Page texts, stored the way the extractor joins them. */
  pages?: string[];
}): Promise<PdfResponse> {
  const formData = new FormData();
  formData.append(
    "file",
    new File([uniquePdfBytes(options.tag)], options.fileName, { type: "application/pdf" }),
  );
  formData.append("fullText", options.pages ? options.pages.join("\f") : "text");
  formData.append("pageCount", String(options.pages?.length ?? 1));
  if (options.thumbnail) {
    formData.append(
      "thumbnail",
      new File([options.thumbnail], "cover.webp", { type: "image/webp" }),
    );
  }

  const response = await apiFetch("https://example.com/api/pdf/open", {
    method: "POST",
    body: formData,
  });
  return (await response.json()) as PdfResponse;
}

/** Shape returned by the PDF endpoints the tests assert on. */
interface PdfResponse {
  id: string;
  fileName: string;
  pageCount: number;
  fullText: string;
  hasThumbnail?: boolean;
  selections?: unknown[];
  readingState?: unknown;
}

/** The 12-byte RIFF/WEBP header a cover has to start with, and nothing more. */
const FAKE_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** The content hash a book is stored under, which its R2 keys are derived from. */
async function storedFileHash(pdfId: string): Promise<string> {
  const row = (await env.DB.prepare("SELECT file_hash FROM pdfs WHERE id = ?")
    .bind(pdfId)
    .first()) as { file_hash: string };
  return row.file_hash;
}

/** Row count for a table filtered by one column, used to observe cascade deletes. */
async function countRows(table: string, column: string, value: string): Promise<number> {
  const row = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first()) as { count: number };
  return row.count;
}

/**
 * Bindings that fail every call, so the paths taken when D1 or R2 is
 * unavailable can be driven without breaking the shared database.
 */
function unavailableBindings() {
  return {
    DB: {
      prepare() {
        throw new Error("D1 is unavailable");
      },
    },
    PDF_BUCKET: {
      head: () => Promise.reject(new Error("R2 is unavailable")),
      get: () => Promise.reject(new Error("R2 is unavailable")),
    },
    LLM_API_KEY: "test-key",
    // The guard runs before the route, so these have to be here too — without
    // them the request is refused for want of a session and never reaches the
    // storage failure this is about.
    AUTH_USERNAME: env.AUTH_USERNAME,
    AUTH_PASSWORD: env.AUTH_PASSWORD,
    AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET,
  } as unknown as {
    DB: D1Database;
    PDF_BUCKET: R2Bucket;
    LLM_API_KEY: string;
    AUTH_USERNAME: string;
    AUTH_PASSWORD: string;
    AUTH_SESSION_SECRET: string;
  };
}

/** A signed-in request, for the paths that go through `app` rather than the Worker. */
async function signedInRequest(): Promise<RequestInit> {
  const token = await issueSession(env.AUTH_SESSION_SECRET, Date.now());
  return { headers: { Cookie: `${SESSION_COOKIE}=${token}` } };
}

describe("failures outside a route's own handling", () => {
  it("answers in the error envelope when the shelf cannot be read from storage", async () => {
    const response = await app.request(
      "https://example.com/api/pdfs",
      await signedInRequest(),
      unavailableBindings(),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  });

  it("answers in the error envelope when a route's own query throws", async () => {
    // No try/catch stands between this route and D1, so before the app had an
    // onError the reply was a text/plain "Internal Server Error" outside the
    // envelope every client reads.
    const response = await app.request(
      "https://example.com/api/pdf/any-book/file",
      await signedInRequest(),
      unavailableBindings(),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  });

  it("answers in the error envelope for an API path that does not exist", async () => {
    const response = await app.request(
      "https://example.com/api/no-such-endpoint",
      await signedInRequest(),
      unavailableBindings(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "ROUTE_NOT_FOUND", message: "No such API endpoint" },
    });
  });
});

describe("POST /api/pdf/open", () => {
  it("uploads a PDF file and returns its metadata", async () => {
    // Its own bytes, so its own row: this asserts the whole answer, and the
    // empty highlights and absent place it names are the two things a
    // re-upload does not put back.
    const formData = new FormData();
    formData.append(
      "file",
      new File([uniquePdfBytes("open-metadata")], "test.pdf", { type: "application/pdf" }),
    );
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const response = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(200);
    // The whole answer: the picker seeds its cache from this very payload, so a
    // field that went missing or arrived unasked-for is the reader opening a
    // book with something wrong on the page.
    expect(await response.json()).toStrictEqual({
      id: expect.any(String),
      fileName: "test.pdf",
      pageCount: 1,
      fullText: "test content",
      readingState: null,
    });
  });

  it("returns 400 when no file is provided", async () => {
    const formData = new FormData();
    formData.append("fullText", "test");
    formData.append("pageCount", "1");

    const response = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "No PDF file provided" },
    });
  });

  it("returns 400 when the client extracted no text, rather than storing a blank book", async () => {
    // What a book whose fonts need a CMap looks like when the viewer could not
    // read it: the file is fine, and every page came back empty.
    const formData = new FormData();
    formData.append(
      "file",
      new File([MINIMAL_PDF_BYTES], "blank.pdf", { type: "application/pdf" }),
    );
    formData.append("fullText", "");
    formData.append("pageCount", "1");

    const response = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Missing fullText or pageCount" },
    });
  });

  it("refreshes stored metadata when the same file is re-opened with new extraction results", async () => {
    // Both uploads share one tag on purpose — same bytes is what makes them the
    // same book — but no other test writes to this one.
    const sameBook = uniquePdfBytes("open-refresh");

    const staleForm = new FormData();
    staleForm.append("file", new File([sameBook], "stale.pdf", { type: "application/pdf" }));
    staleForm.append("fullText", "stale text");
    staleForm.append("pageCount", "16");

    const staleResponse = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: staleForm,
    });
    const stale = (await staleResponse.json()) as PdfResponse;

    const freshForm = new FormData();
    freshForm.append("file", new File([sameBook], "fresh.pdf", { type: "application/pdf" }));
    freshForm.append("fullText", "fresh text");
    freshForm.append("pageCount", "209");

    const freshResponse = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: freshForm,
    });
    const fresh = (await freshResponse.json()) as PdfResponse;

    expect(fresh).toStrictEqual({
      id: stale.id,
      fileName: "fresh.pdf",
      pageCount: 209,
      fullText: "fresh text",
      readingState: null,
    });

    // The refreshed values must be persisted, not just echoed back
    const getResponse = await apiFetch(`https://example.com/api/pdf/${fresh.id}`);
    expect(await getResponse.json()).toStrictEqual({
      id: stale.id,
      fileName: "fresh.pdf",
      pageCount: 209,
      hasThumbnail: false,
      selections: [],
      readingState: null,
    });
  });

  it("re-opens the same file and returns the existing pdfId", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const response1 = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });
    const json1 = (await response1.json()) as PdfResponse;

    // New FormData for second request (FormData is consumed after fetch)
    const formData2 = new FormData();
    formData2.append(
      "file",
      new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }),
    );
    formData2.append("fullText", "test content");
    formData2.append("pageCount", "1");

    const response2 = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData2,
    });
    const json2 = (await response2.json()) as PdfResponse;

    expect(json2.id).toBe(json1.id);
  });
});

describe("GET /api/pdf/:pdfId", () => {
  it("returns PDF metadata for a valid pdfId", async () => {
    // Its own bytes, as above: the empty highlights and absent place asserted
    // here belong to this test and are not restored by a re-upload.
    const formData = new FormData();
    formData.append(
      "file",
      new File([uniquePdfBytes("get-metadata")], "test.pdf", { type: "application/pdf" }),
    );
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const uploadResponse = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });
    const uploadJson = (await uploadResponse.json()) as PdfResponse;

    const response = await apiFetch(`https://example.com/api/pdf/${uploadJson.id}`);
    expect(response.status).toBe(200);

    expect(await response.json()).toStrictEqual({
      id: uploadJson.id,
      fileName: "test.pdf",
      pageCount: 1,
      hasThumbnail: false,
      selections: [],
      readingState: null,
    });
  });

  it("returns 404 for a non-existent pdfId", async () => {
    const response = await apiFetch("https://example.com/api/pdf/non-existent-id");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });
});

describe("GET /api/pdf/:pdfId/file", () => {
  it("serves the stored PDF binary for rendering", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const uploadResponse = await apiFetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });
    const uploadJson = (await uploadResponse.json()) as PdfResponse;

    const response = await apiFetch(`https://example.com/api/pdf/${uploadJson.id}/file`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toStrictEqual(MINIMAL_PDF_BYTES);
  });

  it("tells the browser to keep the binary, since a book's bytes never change", async () => {
    // The id is derived from the content hash, so a given book is the same
    // bytes forever: re-reading it should not cost the download again.
    const book = await uploadBook({ tag: "file-cache", fileName: "cache.pdf" });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/file`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).not.toBeNull();
  });

  it("answers a reload holding the file with 304 rather than the bytes again", async () => {
    const book = await uploadBook({ tag: "file-304", fileName: "revalidate.pdf" });
    const first = await apiFetch(`https://example.com/api/pdf/${book.id}/file`);
    const etag = first.headers.get("ETag")!;

    const second = await apiFetch(`https://example.com/api/pdf/${book.id}/file`, {
      headers: { "If-None-Match": etag },
    });

    expect(second.status).toBe(304);
    expect(await second.arrayBuffer()).toStrictEqual(new ArrayBuffer(0));
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("hands the bytes over when the browser holds a different version", async () => {
    const book = await uploadBook({ tag: "file-stale", fileName: "stale.pdf" });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/file`, {
      headers: { "If-None-Match": '"not-the-one-stored"' },
    });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(
      uniquePdfBytes("file-stale"),
    );
  });

  it("returns 404 for a non-existent pdfId", async () => {
    const response = await apiFetch("https://example.com/api/pdf/non-existent-id/file");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/pdfs", () => {
  it("lists uploaded books with their thumbnail availability", async () => {
    const withCover = await uploadBook({
      tag: "shelf-with-cover",
      fileName: "with-cover.pdf",
      thumbnail: new Blob([FAKE_WEBP], { type: "image/webp" }),
    });
    const withoutCover = await uploadBook({
      tag: "shelf-without-cover",
      fileName: "without-cover.pdf",
    });

    const response = await apiFetch("https://example.com/api/pdfs");
    expect(response.status).toBe(200);

    const { books } = (await response.json()) as {
      books: { id: string; fileName: string; pageCount: number; hasThumbnail: boolean }[];
    };

    const covered = books.find((b) => b.id === withCover.id);
    const uncovered = books.find((b) => b.id === withoutCover.id);

    expect(covered).toStrictEqual({
      id: withCover.id,
      fileName: "with-cover.pdf",
      pageCount: 1,
      updatedAt: expect.any(String),
      hasThumbnail: true,
    });
    expect(uncovered?.hasThumbnail).toBe(false);
  });
});

describe("PDF thumbnails", () => {
  it("serves the thumbnail uploaded alongside the PDF", async () => {
    const book = await uploadBook({
      tag: "thumb-served",
      fileName: "cover.pdf",
      thumbnail: new Blob([FAKE_WEBP], { type: "image/webp" }),
    });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(FAKE_WEBP);
  });

  it("returns 404 when the book has no thumbnail yet", async () => {
    const book = await uploadBook({ tag: "thumb-missing", fileName: "no-cover.pdf" });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "THUMBNAIL_MISSING", message: "No cover stored for this book" },
    });
  });

  it("says the book is missing, not its cover, when the book itself is unknown", async () => {
    // Two different 404s on one endpoint: the shelf asking for a cover of a
    // book it still lists is a stale shelf, while a book with no cover is
    // ordinary and the card falls back to the title.
    const response = await apiFetch("https://example.com/api/pdf/no-such-book/thumbnail");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });

  it("stores a thumbnail uploaded later via PUT", async () => {
    const book = await uploadBook({ tag: "thumb-backfill", fileName: "backfill.pdf" });

    const putResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: FAKE_WEBP,
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);
    expect(getResponse.status).toBe(200);
    expect(new Uint8Array(await getResponse.arrayBuffer())).toStrictEqual(FAKE_WEBP);
  });

  it("refuses a cover that is not a WebP image", async () => {
    const book = await uploadBook({ tag: "thumb-not-webp", fileName: "not-webp.pdf" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    const putResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: png,
    });

    expect(putResponse.status).toBe(400);
    expect(await putResponse.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Thumbnail is not a WebP image" },
    });
    // Nothing was stored, so the shelf still falls back to the placeholder
    const getResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);
    expect(getResponse.status).toBe(404);
  });

  it("stores a cover of exactly the size limit", async () => {
    const book = await uploadBook({ tag: "thumb-at-limit", fileName: "at-limit.pdf" });
    const atLimit = new Uint8Array(2 * 1024 * 1024);
    atLimit.set(FAKE_WEBP, 0);

    const putResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: atLimit,
    });

    expect(putResponse.status).toBe(200);
    const getResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);
    expect(getResponse.status).toBe(200);
    expect((await getResponse.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
  });

  it("refuses a cover far larger than a rendered page", async () => {
    const book = await uploadBook({ tag: "thumb-too-big", fileName: "too-big.pdf" });
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    oversized.set(FAKE_WEBP, 0);

    const putResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: oversized,
    });

    expect(putResponse.status).toBe(400);
    expect(await putResponse.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Thumbnail is larger than 2097152 bytes" },
    });
    const getResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/thumbnail`);
    expect(getResponse.status).toBe(404);
  });

  it("returns 404 when putting a thumbnail for an unknown book", async () => {
    const response = await apiFetch("https://example.com/api/pdf/does-not-exist/thumbnail", {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: FAKE_WEBP,
    });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/pdf/:pdfId", () => {
  it("removes only the deleted book, along with its selections, chats and stored files", async () => {
    const book = await uploadBook({
      tag: "delete-book",
      fileName: "delete-me.pdf",
      thumbnail: new Blob([FAKE_WEBP], { type: "image/webp" }),
    });
    const survivor = await uploadBook({
      tag: "delete-survivor",
      fileName: "keep-me.pdf",
      thumbnail: new Blob([FAKE_WEBP], { type: "image/webp" }),
    });

    const selectionResponse = await apiFetch(`https://example.com/api/pdf/${book.id}/selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "消えるべき選択",
        pageNumber: 1,
        positionData: { rects: [] },
      }),
    });
    const selection = (await selectionResponse.json()) as { id: string };

    // Seeded directly: POST .../chats streams from DeepSeek over SSE, which is far
    // more machinery than this cascade check needs.
    await env.DB.prepare(
      "INSERT INTO chat_messages (id, selection_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "chat-delete-book",
        selection.id,
        "user",
        "この選択について教えて",
        "2026-01-01T00:00:00Z",
      )
      .run();

    const fileHash = await storedFileHash(book.id);
    const survivorHash = await storedFileHash(survivor.id);

    expect(await countRows("selections", "pdf_id", book.id)).toBe(1);
    expect(await countRows("chat_messages", "selection_id", selection.id)).toBe(1);
    expect(await env.PDF_BUCKET.head(pdfObjectKey(fileHash))).not.toBeNull();
    expect(await env.PDF_BUCKET.head(thumbnailObjectKey(fileHash))).not.toBeNull();

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ deleted: true });

    const getResponse = await apiFetch(`https://example.com/api/pdf/${book.id}`);
    expect(getResponse.status).toBe(404);
    expect(await countRows("selections", "pdf_id", book.id)).toBe(0);
    expect(await countRows("chat_messages", "selection_id", selection.id)).toBe(0);
    expect(await env.PDF_BUCKET.head(pdfObjectKey(fileHash))).toBeNull();
    expect(await env.PDF_BUCKET.head(thumbnailObjectKey(fileHash))).toBeNull();

    // A delete that lost its WHERE clause would empty the whole shelf
    const survivorResponse = await apiFetch(`https://example.com/api/pdf/${survivor.id}`);
    expect(survivorResponse.status).toBe(200);
    expect(await env.PDF_BUCKET.head(pdfObjectKey(survivorHash))).not.toBeNull();
    expect(await env.PDF_BUCKET.head(thumbnailObjectKey(survivorHash))).not.toBeNull();
  });

  it("returns 404 for an unknown book", async () => {
    const response = await apiFetch("https://example.com/api/pdf/does-not-exist", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });
});

describe("GET /api/pdf/:pdfId/locate", () => {
  it("locates the page holding a passage quoted from a link", async () => {
    const book = await uploadBook({
      tag: "locate-hit",
      fileName: "locate.pdf",
      pages: ["まえがき", "第1章", "エッジ は サーバーレス 実行基盤 です"],
    });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent("エッジはサーバーレス実行基盤です")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ found: true, pageNumber: 3 });
  });

  it("reports no page when the passage is not in the book", async () => {
    const book = await uploadBook({
      tag: "locate-miss",
      fileName: "locate-miss.pdf",
      pages: ["まえがき", "第1章"],
    });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent("存在しない一文")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ found: false, miss: "not-in-book" });
  });

  it("returns 400 when no text is given", async () => {
    const book = await uploadBook({ tag: "locate-empty", fileName: "locate-empty.pdf" });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/locate`);

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid query parameter: text" },
    });
  });

  it("looks up a passage of exactly the length limit", async () => {
    const passage = "あ".repeat(2000);
    const book = await uploadBook({
      tag: "locate-at-limit",
      fileName: "locate-at-limit.pdf",
      pages: ["まえがき", passage],
    });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent(passage)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ found: true, pageNumber: 2 });
  });

  it("says a link whose passage is only whitespace carried no quote to look up", async () => {
    // `min(1)` lets a single space through, and normalising leaves nothing of it
    const book = await uploadBook({
      tag: "locate-blank",
      fileName: "locate-blank.pdf",
      pages: ["まえがき", "エッジ で 動く"],
    });

    const response = await apiFetch(`https://example.com/api/pdf/${book.id}/locate?text=%20`);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ found: false, miss: "no-quote" });
  });

  it("says a book of one page has nowhere to jump to rather than calling the passage missing", async () => {
    const book = await uploadBook({
      tag: "locate-single",
      fileName: "locate-single.pdf",
      pages: ["エッジ で 動く"],
    });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent("エッジで動く")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ found: false, miss: "single-page-book" });
  });

  it("refuses a passage longer than any quotable one instead of scanning the book for it", async () => {
    const book = await uploadBook({ tag: "locate-long", fileName: "locate-long.pdf" });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${"あ".repeat(2001)}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid query parameter: text" },
    });
  });

  it("returns 404 for an unknown book", async () => {
    const response = await apiFetch("https://example.com/api/pdf/does-not-exist/locate?text=x");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });
});

/** Post a highlight the way the viewer does, with the body left to the caller. */
async function postSelection(pdfId: string, body: unknown): Promise<Response> {
  return apiFetch(`https://example.com/api/pdf/${pdfId}/selections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The highlights of a book, as the viewer receives them.
 *
 * The status is asserted here so that a book which fails to open shows up as
 * "expected 500 to be 200" rather than as a JSON parse error on the words
 * "Internal Server Error".
 */
async function readSelections(pdfId: string): Promise<Record<string, unknown>[]> {
  const response = await apiFetch(`https://example.com/api/pdf/${pdfId}`);
  expect(response.status).toBe(200);
  const { selections } = (await response.json()) as { selections: Record<string, unknown>[] };
  return selections;
}

describe("POST /api/pdf/:pdfId/selections", () => {
  it("rejects a pageNumber sent as a string instead of storing it in the integer column", async () => {
    const book = await uploadBook({ tag: "sel-page-string", fileName: "sel-page-string.pdf" });

    const response = await postSelection(book.id, {
      selectedText: "Workers",
      pageNumber: "3",
      positionData: { rects: [] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request body: pageNumber" },
    });
    expect(await readSelections(book.id)).toStrictEqual([]);
  });

  it("rejects positionData that carries no rects, which the viewer cannot draw", async () => {
    const book = await uploadBook({ tag: "sel-no-rects", fileName: "sel-no-rects.pdf" });

    const response = await postSelection(book.id, {
      selectedText: "Workers",
      pageNumber: 1,
      positionData: { pageWidth: 600 },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body: positionData.rects",
      },
    });
    expect(await readSelections(book.id)).toStrictEqual([]);
  });

  it("keeps only rects and pageWidth when the viewer posts its whole measurement", async () => {
    const book = await uploadBook({ tag: "sel-strip", fileName: "sel-strip.pdf" });
    const rects = [{ x: 40, y: 40, width: 160, height: 24 }];

    const response = await postSelection(book.id, {
      selectedText: "Workers",
      pageNumber: 2,
      positionData: { startIndex: 0, endIndex: 7, pageNumber: 2, rects, pageWidth: 600 },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toStrictEqual({
      id: expect.any(String),
      selectedText: "Workers",
      pageNumber: 2,
      positionData: { rects, pageWidth: 600 },
      createdAt: expect.any(String),
    });
    expect(await readSelections(book.id)).toStrictEqual([
      {
        id: expect.any(String),
        selectedText: "Workers",
        pageNumber: 2,
        positionData: { rects, pageWidth: 600 },
        color: "#FFEB3B",
        createdAt: expect.any(String),
      },
    ]);
  });
});

describe("DELETE /api/pdf/:pdfId/selections/:selId", () => {
  /** A highlight with one exchange already saved against it. */
  async function highlightWithAChat(tag: string) {
    const book = await uploadBook({ tag, fileName: `${tag}.pdf` });
    const created = (await (
      await postSelection(book.id, {
        selectedText: "Workers",
        pageNumber: 1,
        positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      })
    ).json()) as { id: string };

    await env.DB.prepare(
      "INSERT INTO chat_messages (id, selection_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(`msg-${tag}`, created.id, "user", "この選択について教えて", "2026-01-01T00:00:00Z")
      .run();

    return { book, selectionId: created.id };
  }

  it("takes the conversation with the highlight, so nothing is left pointing at a gone passage", async () => {
    const { book, selectionId } = await highlightWithAChat("sel-delete");

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/selections/${selectionId}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ deleted: true });
    expect(await readSelections(book.id)).toStrictEqual([]);
    expect(await countRows("chat_messages", "selection_id", selectionId)).toBe(0);
  });

  it("leaves the book's other highlights where they are", async () => {
    // A delete that lost its WHERE clause would clear the whole book, and the
    // end-to-end suites lean on this endpoint to reset between tests.
    const { book, selectionId } = await highlightWithAChat("sel-delete-neighbour");
    const survivor = (await (
      await postSelection(book.id, {
        selectedText: "Durable Objects",
        pageNumber: 2,
        positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      })
    ).json()) as { id: string };

    await apiFetch(`https://example.com/api/pdf/${book.id}/selections/${selectionId}`, {
      method: "DELETE",
    });

    expect(await readSelections(book.id)).toStrictEqual([
      {
        id: survivor.id,
        selectedText: "Durable Objects",
        pageNumber: 2,
        positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
        color: "#FFEB3B",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("still answers deleted for a highlight that has already gone", async () => {
    // Deliberately not a 404: every end-to-end run clears the highlights left
    // by the last one, and a suite that had to know which of them still exist
    // would be reset by whichever test ran first.
    const book = await uploadBook({ tag: "sel-delete-twice", fileName: "sel-delete-twice.pdf" });

    const response = await apiFetch(
      `https://example.com/api/pdf/${book.id}/selections/never-existed`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ deleted: true });
  });
});

describe("GET /api/pdf/:pdfId/search", () => {
  /**
   * A book with two highlights: the first names Workers in the passage itself,
   * the second only in the answer saved against it.
   */
  async function bookWithSearchableChats(tag: string) {
    const book = await uploadBook({ tag, fileName: `${tag}.pdf` });
    const inPassage = (await (
      await postSelection(book.id, {
        selectedText: "Workers はリクエストごとに分離されます",
        pageNumber: 1,
        positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      })
    ).json()) as { id: string };
    const inAnswer = (await (
      await postSelection(book.id, {
        selectedText: "エッジは実行単位をまたげません",
        pageNumber: 2,
        positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      })
    ).json()) as { id: string };

    await env.DB.prepare(
      "INSERT INTO chat_messages (id, selection_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        `msg-${tag}`,
        inAnswer.id,
        "assistant",
        "状態を持てないのは Workers が毎回別のインスタンスになるためです",
        "2026-01-01T00:00:00Z",
      )
      .run();

    return { book, inPassage: inPassage.id, inAnswer: inAnswer.id };
  }

  async function search(pdfId: string, q: string) {
    return apiFetch(`https://example.com/api/pdf/${pdfId}/search?q=${encodeURIComponent(q)}`);
  }

  it("finds a highlight by the passage the reader marked", async () => {
    const { book, inPassage } = await bookWithSearchableChats("search-passage");

    const response = await search(book.id, "リクエストごと");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ selectionIds: [inPassage] });
  });

  it("finds a highlight by what was said in its chat, not just the passage", async () => {
    const { book, inAnswer } = await bookWithSearchableChats("search-chat");

    const response = await search(book.id, "毎回別のインスタンス");

    expect(await response.json()).toStrictEqual({ selectionIds: [inAnswer] });
  });

  it("names a highlight once when the query is in both its passage and its chat", async () => {
    const { book, inPassage, inAnswer } = await bookWithSearchableChats("search-both");

    const response = await search(book.id, "Workers");

    const { selectionIds } = (await response.json()) as { selectionIds: string[] };
    expect(selectionIds.toSorted()).toStrictEqual([inPassage, inAnswer].toSorted());
  });

  it("finds nothing for a query that is in neither", async () => {
    const { book } = await bookWithSearchableChats("search-miss");

    expect(await (await search(book.id, "みつからない語")).json()).toStrictEqual({
      selectionIds: [],
    });
  });

  it("leaves another book's highlights out of the answer", async () => {
    const { book } = await bookWithSearchableChats("search-scope-a");
    const other = await uploadBook({ tag: "search-scope-b", fileName: "search-scope-b.pdf" });
    await postSelection(other.id, {
      selectedText: "Workers はこちらの本にもあります",
      pageNumber: 1,
      positionData: { rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
    });

    const { selectionIds } = (await (await search(book.id, "Workers")).json()) as {
      selectionIds: string[];
    };

    expect(selectionIds).toHaveLength(2);
  });

  it("treats a percent sign as a character to look for, not as a wildcard", async () => {
    // Passed straight into LIKE it would match every highlight in the book.
    const { book } = await bookWithSearchableChats("search-wildcard");

    expect(await (await search(book.id, "%")).json()).toStrictEqual({ selectionIds: [] });
  });

  it("refuses a search of a book that is not there", async () => {
    const response = await search("no-such-book", "Workers");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });

  it("refuses an empty query rather than answering with the whole book", async () => {
    const { book } = await bookWithSearchableChats("search-empty");

    expect((await search(book.id, "")).status).toBe(400);
  });
});

describe("GET /api/pdf/:pdfId highlight geometry", () => {
  it("still serves a book whose stored positionData cannot be read", async () => {
    const book = await uploadBook({ tag: "sel-unreadable", fileName: "sel-unreadable.pdf" });
    // Written straight to D1: the endpoint refuses to store either of these
    // shapes now, but rows like them predate that.
    await env.DB.prepare(
      "INSERT INTO selections (id, pdf_id, selected_text, page_number, position_data, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "sel-legacy-shape",
        book.id,
        "旧い形のハイライト",
        1,
        JSON.stringify({ startIndex: 0, endIndex: 1, pageNumber: 1, rects: [], pageWidth: 900 }),
        "#FFEB3B",
        "2026-01-01T00:00:00Z",
        "sel-broken-json",
        book.id,
        "壊れたハイライト",
        2,
        "{not json",
        "#FF9800",
        "2026-01-02T00:00:00Z",
      )
      .run();

    expect(await readSelections(book.id)).toStrictEqual([
      {
        id: "sel-legacy-shape",
        selectedText: "旧い形のハイライト",
        pageNumber: 1,
        positionData: { rects: [], pageWidth: 900 },
        color: "#FFEB3B",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "sel-broken-json",
        selectedText: "壊れたハイライト",
        pageNumber: 2,
        positionData: { rects: [] },
        color: "#FF9800",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ]);
  });
});

/** The reader's place as the API hands it over, or null for an unread book. */
type StoredReadingState = {
  page: number;
  selectionId: string | null;
  outlineOpen: boolean | null;
  chatPanelOpen: boolean | null;
} | null;

function putReadingState(pdfId: string, body: unknown): Promise<Response> {
  return apiFetch(`https://example.com/api/pdf/${pdfId}/reading-state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The place the book itself reports, which is where a second device reads it from. */
async function readingStateOf(pdfId: string): Promise<StoredReadingState> {
  const response = await apiFetch(`https://example.com/api/pdf/${pdfId}`);
  return ((await response.json()) as { readingState: StoredReadingState }).readingState;
}

async function bookUpdatedAt(pdfId: string): Promise<string> {
  const row = (await env.DB.prepare("SELECT updated_at FROM pdfs WHERE id = ?")
    .bind(pdfId)
    .first()) as { updated_at: string };
  return row.updated_at;
}

describe("PUT /api/pdf/:pdfId/reading-state", () => {
  it("hands the saved page, chat, outline and panel to whoever opens the book next", async () => {
    const book = await uploadBook({ tag: "place-roundtrip", fileName: "roundtrip.pdf" });

    const response = await putReadingState(book.id, {
      page: 3,
      selectionId: "sel-roundtrip",
      outlineOpen: false,
      chatPanelOpen: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ saved: true });
    expect(await readingStateOf(book.id)).toStrictEqual({
      page: 3,
      selectionId: "sel-roundtrip",
      outlineOpen: false,
      chatPanelOpen: false,
    });
  });

  it("reports no answer either way for panels no wide screen has spoken about", async () => {
    // What a book read only on a phone holds, and what rows written before the
    // panels were saved hold: a page, and nothing about either panel.
    const book = await uploadBook({ tag: "place-panels-unsaid", fileName: "unsaid.pdf" });

    await putReadingState(book.id, { page: 4, selectionId: null });

    expect(await readingStateOf(book.id)).toStrictEqual({
      page: 4,
      selectionId: null,
      outlineOpen: null,
      chatPanelOpen: null,
    });
  });

  it("reports no place at all for a book that has never been read", async () => {
    const book = await uploadBook({ tag: "place-unread", fileName: "unread.pdf" });

    expect(await readingStateOf(book.id)).toBeNull();
  });

  it("keeps the outline and panel a wide screen chose when a narrow one saves without them", async () => {
    const book = await uploadBook({ tag: "place-narrow", fileName: "narrow.pdf" });
    await putReadingState(book.id, {
      page: 2,
      selectionId: null,
      outlineOpen: true,
      chatPanelOpen: false,
    });

    const response = await putReadingState(book.id, { page: 5, selectionId: null });

    expect(response.status).toBe(200);
    expect(await readingStateOf(book.id)).toStrictEqual({
      page: 5,
      selectionId: null,
      outlineOpen: true,
      chatPanelOpen: false,
    });
  });

  it("leaves the shelf order alone: reading a book is not opening it again", async () => {
    const book = await uploadBook({ tag: "place-shelf-order", fileName: "shelf-order.pdf" });
    await env.DB.prepare("UPDATE pdfs SET updated_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", book.id)
      .run();

    const response = await putReadingState(book.id, {
      page: 8,
      selectionId: null,
      outlineOpen: true,
    });

    expect(response.status).toBe(200);
    expect(await bookUpdatedAt(book.id)).toBe("2020-01-01T00:00:00.000Z");
  });

  it("keeps the reader's place when the same file is uploaded again", async () => {
    const book = await uploadBook({ tag: "place-reopen", fileName: "reopen.pdf" });
    await putReadingState(book.id, {
      page: 7,
      selectionId: "sel-reopen",
      outlineOpen: false,
      chatPanelOpen: false,
    });

    const reopened = await uploadBook({ tag: "place-reopen", fileName: "reopen-renamed.pdf" });

    expect(reopened.id).toBe(book.id);
    // Also on the upload's own answer: the picker seeds the cache from it, and a
    // seed without the place would open an already-read book at page 1.
    expect(reopened.readingState).toStrictEqual({
      page: 7,
      selectionId: "sel-reopen",
      outlineOpen: false,
      chatPanelOpen: false,
    });
    expect(await readingStateOf(book.id)).toStrictEqual({
      page: 7,
      selectionId: "sel-reopen",
      outlineOpen: false,
      chatPanelOpen: false,
    });
  });

  it("answers 404 for a book that is not on the shelf", async () => {
    const response = await putReadingState("non-existent-id", { page: 1, selectionId: null });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });

  it("names the field at fault when the page is not a page", async () => {
    const book = await uploadBook({ tag: "place-invalid", fileName: "invalid.pdf" });

    const response = await putReadingState(book.id, { page: 0, selectionId: null });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request body: page" },
    });
  });

  it("answers in the error envelope when the store refuses the write", async () => {
    const token = await issueSession(env.AUTH_SESSION_SECRET, Date.now());
    const response = await app.request(
      "https://example.com/api/pdf/any-book/reading-state",
      {
        method: "PUT",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ page: 2, selectionId: null }),
      },
      unavailableBindings(),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  });
});

/** An IdClock that always hands out the same id and timestamp. */
function fixedIdClock(id: string, now: string): IdClock {
  return { newId: () => id, now: () => now };
}

/** The stored book row, so the ids and timestamps a write produced are visible. */
async function storedBookRow(pdfId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare(
    "SELECT id, file_path, file_name, file_hash, full_text, page_count, created_at, updated_at FROM pdfs WHERE id = ?",
  )
    .bind(pdfId)
    .first();
}

describe("openPdf with an injected IdClock", () => {
  it("stores a new book under the id and timestamps the clock hands out", async () => {
    const fileHash = "hash-idclock-new";

    const stored = await openPdf(
      env.DB,
      env.PDF_BUCKET,
      {
        fileName: "injected.pdf",
        fileHash,
        fullText: "本文",
        pageCount: 3,
        arrayBuffer: uniquePdfBytes("idclock-new").buffer as ArrayBuffer,
      },
      fixedIdClock("book-idclock-new", "2026-01-02T03:04:05.678Z"),
    );

    expect(stored._unsafeUnwrap()).toStrictEqual({
      id: "book-idclock-new",
      fileName: "injected.pdf",
      pageCount: 3,
      fullText: "本文",
      readingState: null,
    });
    expect(await storedBookRow("book-idclock-new")).toStrictEqual({
      id: "book-idclock-new",
      file_path: `pdfs/${fileHash}.pdf`,
      file_name: "injected.pdf",
      file_hash: fileHash,
      full_text: "本文",
      page_count: 3,
      created_at: "2026-01-02T03:04:05.678Z",
      updated_at: "2026-01-02T03:04:05.678Z",
    });
  });

  it("keeps the first id and moves only updated_at when the same file is re-opened", async () => {
    const fileHash = "hash-idclock-reopen";
    const input = {
      fileName: "first.pdf",
      fileHash,
      fullText: "初回の本文",
      pageCount: 3,
      arrayBuffer: uniquePdfBytes("idclock-reopen").buffer as ArrayBuffer,
    };
    await openPdf(
      env.DB,
      env.PDF_BUCKET,
      input,
      fixedIdClock("book-idclock-reopen", "2026-01-02T03:04:05.678Z"),
    );

    const reopened = await openPdf(
      env.DB,
      env.PDF_BUCKET,
      { ...input, fileName: "second.pdf", fullText: "再抽出した本文", pageCount: 4 },
      fixedIdClock("book-idclock-ignored", "2026-03-04T05:06:07.891Z"),
    );

    expect(reopened._unsafeUnwrap()).toStrictEqual({
      id: "book-idclock-reopen",
      fileName: "second.pdf",
      pageCount: 4,
      fullText: "再抽出した本文",
      readingState: null,
    });
    expect(await storedBookRow("book-idclock-reopen")).toStrictEqual({
      id: "book-idclock-reopen",
      file_path: `pdfs/${fileHash}.pdf`,
      file_name: "second.pdf",
      file_hash: fileHash,
      full_text: "再抽出した本文",
      page_count: 4,
      created_at: "2026-01-02T03:04:05.678Z",
      updated_at: "2026-03-04T05:06:07.891Z",
    });
  });
});
