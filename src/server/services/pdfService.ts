import { ulid } from "ulid";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import { pdfs, selections } from "../db/schema";

/**
 * R2 object key for a PDF, derived from its content hash.
 */
export function pdfObjectKey(fileHash: string): string {
  return `pdfs/${fileHash}.pdf`;
}

/**
 * R2 object key for a PDF's cover thumbnail.
 */
export function thumbnailObjectKey(fileHash: string): string {
  return `thumbnails/${fileHash}.webp`;
}

export const THUMBNAIL_CONTENT_TYPE = "image/webp";

/**
 * The two non-deterministic values every write needs. Injected so tests can
 * pin the ids and timestamps a request produces.
 */
export interface IdClock {
  newId: () => string;
  now: () => string;
}

export const systemIdClock: IdClock = {
  newId: ulid,
  now: () => new Date().toISOString(),
};

export interface PdfMetadata {
  id: string;
  fileName: string;
  pageCount: number;
  fullText: string;
}

interface OpenPdfInput {
  fileName: string;
  fileHash: string;
  fullText: string;
  pageCount: number;
  arrayBuffer: ArrayBuffer;
  thumbnail?: ArrayBuffer;
}

export interface BookSummary {
  id: string;
  fileName: string;
  pageCount: number;
  updatedAt: string;
  hasThumbnail: boolean;
}

/**
 * List every stored book, most recently opened first, for the shelf view.
 */
export async function listPdfs(db: D1Database, bucket: R2Bucket): Promise<BookSummary[]> {
  const rows = await drizzle(db)
    .select({
      id: pdfs.id,
      fileName: pdfs.fileName,
      pageCount: pdfs.pageCount,
      fileHash: pdfs.fileHash,
      updatedAt: pdfs.updatedAt,
    })
    .from(pdfs)
    .orderBy(desc(pdfs.updatedAt))
    .all();

  return Promise.all(
    rows.map(async ({ fileHash, ...book }) => ({
      ...book,
      hasThumbnail: (await bucket.head(thumbnailObjectKey(fileHash))) !== null,
    })),
  );
}

/**
 * Open (or re-open) a PDF file.
 * Text extraction is done client-side (browser pdf.js), so the server receives
 * pre-computed fileHash, fullText, and pageCount.
 * The PDF binary is stored in R2; D1 keeps the metadata and the object key.
 * Returns the existing record if a file with the same hash already exists.
 */
export async function openPdf(
  db: D1Database,
  bucket: R2Bucket,
  input: OpenPdfInput,
  idClock: IdClock = systemIdClock,
): Promise<PdfMetadata> {
  const { fileName, fileHash, fullText, pageCount, arrayBuffer, thumbnail } = input;
  const d1Db = drizzle(db);
  const objectKey = pdfObjectKey(fileHash);

  if (thumbnail) {
    await bucket.put(thumbnailObjectKey(fileHash), thumbnail, {
      httpMetadata: { contentType: THUMBNAIL_CONTENT_TYPE },
    });
  }

  const existing = await d1Db.select().from(pdfs).where(eq(pdfs.fileHash, fileHash)).get();
  if (existing) {
    // Re-upload the binary if the object is missing (e.g. bucket was cleared).
    const head = await bucket.head(objectKey);
    if (!head) {
      await bucket.put(objectKey, arrayBuffer, {
        httpMetadata: { contentType: "application/pdf" },
      });
    }

    // Refresh the metadata: the caller just re-extracted it, so it supersedes
    // whatever was stored before. Selections and chats stay attached to the id.
    await d1Db
      .update(pdfs)
      .set({ fileName, fullText, pageCount, updatedAt: idClock.now() })
      .where(eq(pdfs.id, existing.id));

    return { id: existing.id, fileName, pageCount, fullText };
  }

  await bucket.put(objectKey, arrayBuffer, {
    httpMetadata: { contentType: "application/pdf" },
  });

  const id = idClock.newId();
  const now = idClock.now();

  await d1Db.insert(pdfs).values({
    id,
    filePath: objectKey,
    fileName,
    fileHash,
    fullText,
    pageCount,
    createdAt: now,
    updatedAt: now,
  });

  return { id, fileName, pageCount, fullText };
}

/**
 * Delete a book together with everything it owns: its selections and chat
 * messages (via the schema's ON DELETE CASCADE) and its R2 objects.
 * D1 is cleared first — if the R2 cleanup then fails, only an unreachable
 * object is left behind, whereas the reverse order would leave a book on the
 * shelf whose binary is gone.
 * Returns false when no such book exists.
 */
export async function deletePdf(db: D1Database, bucket: R2Bucket, pdfId: string): Promise<boolean> {
  const d1Db = drizzle(db);
  const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!pdf) return false;

  await d1Db.delete(pdfs).where(eq(pdfs.id, pdfId));
  await bucket.delete([pdfObjectKey(pdf.fileHash), thumbnailObjectKey(pdf.fileHash)]);

  return true;
}

/**
 * Get a PDF record by id, including its selections.
 */
export async function getPdf(db: D1Database, bucket: R2Bucket, pdfId: string) {
  const d1Db = drizzle(db);
  const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!pdf) return null;

  const selRows = await d1Db.select().from(selections).where(eq(selections.pdfId, pdfId)).all();

  return {
    id: pdf.id,
    fileName: pdf.fileName,
    pageCount: pdf.pageCount,
    hasThumbnail: (await bucket.head(thumbnailObjectKey(pdf.fileHash))) !== null,
    selections: selRows.map((s) => ({
      id: s.id,
      selectedText: s.selectedText,
      pageNumber: s.pageNumber,
      positionData: JSON.parse(s.positionData),
      color: s.color,
      createdAt: s.createdAt,
    })),
  };
}
