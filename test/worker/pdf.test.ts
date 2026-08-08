import { describe, it, expect, beforeAll } from "vite-plus/test";
import { env, applyD1Migrations, SELF } from "cloudflare:test";
import { MINIMAL_PDF_BYTES } from "./fixtures/minimalPdf";
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
}): Promise<{ id: string }> {
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

  const response = await SELF.fetch("https://example.com/api/pdf/open", {
    method: "POST",
    body: formData,
  });
  return (await response.json()) as { id: string };
}

/** Shape returned by the PDF endpoints the tests assert on. */
interface PdfResponse {
  id: string;
  fileName: string;
  pageCount: number;
  fullText: string;
  hasThumbnail?: boolean;
  selections?: unknown[];
}

const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x57, 0x45, 0x42, 0x50]);

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

describe("POST /api/pdf/open", () => {
  it("uploads a PDF file and returns its metadata", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const response = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as PdfResponse;
    expect(json.fileName).toBe("test.pdf");
    expect(json.pageCount).toBe(1);
    expect(json.fullText).toBe("test content");
    expect(typeof json.id).toBe("string");
  });

  it("returns 400 when no file is provided", async () => {
    const formData = new FormData();
    formData.append("fullText", "test");
    formData.append("pageCount", "1");

    const response = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(400);
  });

  it("refreshes stored metadata when the same file is re-opened with new extraction results", async () => {
    const staleForm = new FormData();
    staleForm.append(
      "file",
      new File([MINIMAL_PDF_BYTES], "stale.pdf", { type: "application/pdf" }),
    );
    staleForm.append("fullText", "stale text");
    staleForm.append("pageCount", "16");

    const staleResponse = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: staleForm,
    });
    const stale = (await staleResponse.json()) as PdfResponse;

    const freshForm = new FormData();
    freshForm.append(
      "file",
      new File([MINIMAL_PDF_BYTES], "fresh.pdf", { type: "application/pdf" }),
    );
    freshForm.append("fullText", "fresh text");
    freshForm.append("pageCount", "209");

    const freshResponse = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: freshForm,
    });
    const fresh = (await freshResponse.json()) as PdfResponse;

    expect(fresh.id).toBe(stale.id);
    expect(fresh.pageCount).toBe(209);
    expect(fresh.fullText).toBe("fresh text");
    expect(fresh.fileName).toBe("fresh.pdf");

    // The refreshed values must be persisted, not just echoed back
    const getResponse = await SELF.fetch(`https://example.com/api/pdf/${fresh.id}`);
    const persisted = (await getResponse.json()) as PdfResponse;
    expect(persisted.pageCount).toBe(209);
    expect(persisted.fileName).toBe("fresh.pdf");
  });

  it("re-opens the same file and returns the existing pdfId", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const response1 = await SELF.fetch("https://example.com/api/pdf/open", {
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

    const response2 = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData2,
    });
    const json2 = (await response2.json()) as PdfResponse;

    expect(json2.id).toBe(json1.id);
  });
});

describe("GET /api/pdf/:pdfId", () => {
  it("returns PDF metadata for a valid pdfId", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const uploadResponse = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });
    const uploadJson = (await uploadResponse.json()) as PdfResponse;

    const response = await SELF.fetch(`https://example.com/api/pdf/${uploadJson.id}`);
    expect(response.status).toBe(200);

    const json = (await response.json()) as PdfResponse;
    expect(json.fileName).toBe("test.pdf");
    expect(json.pageCount).toBe(1);
    expect(Array.isArray(json.selections)).toBe(true);
  });

  it("returns 404 for a non-existent pdfId", async () => {
    const response = await SELF.fetch("https://example.com/api/pdf/non-existent-id");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/pdf/:pdfId/file", () => {
  it("serves the stored PDF binary for rendering", async () => {
    const formData = new FormData();
    formData.append("file", new File([MINIMAL_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
    formData.append("fullText", "test content");
    formData.append("pageCount", "1");

    const uploadResponse = await SELF.fetch("https://example.com/api/pdf/open", {
      method: "POST",
      body: formData,
    });
    const uploadJson = (await uploadResponse.json()) as PdfResponse;

    const response = await SELF.fetch(`https://example.com/api/pdf/${uploadJson.id}/file`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(MINIMAL_PDF_BYTES);
  });

  it("returns 404 for a non-existent pdfId", async () => {
    const response = await SELF.fetch("https://example.com/api/pdf/non-existent-id/file");
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

    const response = await SELF.fetch("https://example.com/api/pdfs");
    expect(response.status).toBe(200);

    const { books } = (await response.json()) as {
      books: { id: string; fileName: string; pageCount: number; hasThumbnail: boolean }[];
    };

    const covered = books.find((b) => b.id === withCover.id);
    const uncovered = books.find((b) => b.id === withoutCover.id);

    expect(covered).toEqual({
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

    const response = await SELF.fetch(`https://example.com/api/pdf/${book.id}/thumbnail`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FAKE_WEBP);
  });

  it("returns 404 when the book has no thumbnail yet", async () => {
    const book = await uploadBook({ tag: "thumb-missing", fileName: "no-cover.pdf" });

    const response = await SELF.fetch(`https://example.com/api/pdf/${book.id}/thumbnail`);

    expect(response.status).toBe(404);
  });

  it("stores a thumbnail uploaded later via PUT", async () => {
    const book = await uploadBook({ tag: "thumb-backfill", fileName: "backfill.pdf" });

    const putResponse = await SELF.fetch(`https://example.com/api/pdf/${book.id}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: FAKE_WEBP,
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await SELF.fetch(`https://example.com/api/pdf/${book.id}/thumbnail`);
    expect(getResponse.status).toBe(200);
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(FAKE_WEBP);
  });

  it("returns 404 when putting a thumbnail for an unknown book", async () => {
    const response = await SELF.fetch("https://example.com/api/pdf/does-not-exist/thumbnail", {
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

    const selectionResponse = await SELF.fetch(
      `https://example.com/api/pdf/${book.id}/selections`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "消えるべき選択",
          pageNumber: 1,
          positionData: { rects: [] },
        }),
      },
    );
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

    const response = await SELF.fetch(`https://example.com/api/pdf/${book.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ deleted: true });

    const getResponse = await SELF.fetch(`https://example.com/api/pdf/${book.id}`);
    expect(getResponse.status).toBe(404);
    expect(await countRows("selections", "pdf_id", book.id)).toBe(0);
    expect(await countRows("chat_messages", "selection_id", selection.id)).toBe(0);
    expect(await env.PDF_BUCKET.head(pdfObjectKey(fileHash))).toBeNull();
    expect(await env.PDF_BUCKET.head(thumbnailObjectKey(fileHash))).toBeNull();

    // A delete that lost its WHERE clause would empty the whole shelf
    const survivorResponse = await SELF.fetch(`https://example.com/api/pdf/${survivor.id}`);
    expect(survivorResponse.status).toBe(200);
    expect(await env.PDF_BUCKET.head(pdfObjectKey(survivorHash))).not.toBeNull();
    expect(await env.PDF_BUCKET.head(thumbnailObjectKey(survivorHash))).not.toBeNull();
  });

  it("returns 404 for an unknown book", async () => {
    const response = await SELF.fetch("https://example.com/api/pdf/does-not-exist", {
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

    const response = await SELF.fetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent("エッジはサーバーレス実行基盤です")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pageNumber: 3 });
  });

  it("reports no page when the passage is not in the book", async () => {
    const book = await uploadBook({
      tag: "locate-miss",
      fileName: "locate-miss.pdf",
      pages: ["まえがき", "第1章"],
    });

    const response = await SELF.fetch(
      `https://example.com/api/pdf/${book.id}/locate?text=${encodeURIComponent("存在しない一文")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pageNumber: null });
  });

  it("returns 400 when no text is given", async () => {
    const book = await uploadBook({ tag: "locate-empty", fileName: "locate-empty.pdf" });

    const response = await SELF.fetch(`https://example.com/api/pdf/${book.id}/locate`);

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Missing text" },
    });
  });

  it("returns 404 for an unknown book", async () => {
    const response = await SELF.fetch("https://example.com/api/pdf/does-not-exist/locate?text=x");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });
});

/** Post a highlight the way the viewer does, with the body left to the caller. */
async function postSelection(pdfId: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/api/pdf/${pdfId}/selections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The highlights of a book, as the viewer receives them. */
async function readSelections(pdfId: string): Promise<Record<string, unknown>[]> {
  const response = await SELF.fetch(`https://example.com/api/pdf/${pdfId}`);
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

    const metadata = await openPdf(
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

    expect(metadata).toStrictEqual({
      id: "book-idclock-new",
      fileName: "injected.pdf",
      pageCount: 3,
      fullText: "本文",
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

    const metadata = await openPdf(
      env.DB,
      env.PDF_BUCKET,
      { ...input, fileName: "second.pdf", fullText: "再抽出した本文", pageCount: 4 },
      fixedIdClock("book-idclock-ignored", "2026-03-04T05:06:07.891Z"),
    );

    expect(metadata).toStrictEqual({
      id: "book-idclock-reopen",
      fileName: "second.pdf",
      pageCount: 4,
      fullText: "再抽出した本文",
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
