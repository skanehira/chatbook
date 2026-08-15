import { ulid } from "ulid";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import { ResultAsync, err, ok } from "neverthrow";
import { pdfs, selections } from "../db/schema";
import type {
  BookSummary,
  PdfMetadata,
  ReadingState,
  SaveReadingStateRequest,
} from "../../shared/schemas/book";
import { positionDataSchema, type PositionData } from "../../shared/schemas/selection";
import { notFound, storageFailure, type ServiceError, type StorageError } from "./serviceError";

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

export type { PdfMetadata } from "../../shared/schemas/book";

interface OpenPdfInput {
  fileName: string;
  fileHash: string;
  fullText: string;
  pageCount: number;
  arrayBuffer: ArrayBuffer;
  thumbnail?: ArrayBuffer;
}

export type { BookSummary } from "../../shared/schemas/book";

/**
 * List every stored book, most recently opened first, for the shelf view.
 */
export function listPdfs(
  db: D1Database,
  bucket: R2Bucket,
): ResultAsync<BookSummary[], StorageError> {
  return ResultAsync.fromPromise(readShelf(db, bucket), storageFailure);
}

async function readShelf(db: D1Database, bucket: R2Bucket): Promise<BookSummary[]> {
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
export function openPdf(
  db: D1Database,
  bucket: R2Bucket,
  input: OpenPdfInput,
  idClock: IdClock = systemIdClock,
): ResultAsync<PdfMetadata, StorageError> {
  return ResultAsync.fromPromise(storePdf(db, bucket, input, idClock), storageFailure);
}

async function storePdf(
  db: D1Database,
  bucket: R2Bucket,
  input: OpenPdfInput,
  idClock: IdClock,
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
    // whatever was stored before. Selections, chats and the reader's place stay
    // attached to the id — the columns set here are listed one by one so that
    // re-opening a book never costs the reader their place in it.
    await d1Db
      .update(pdfs)
      .set({ fileName, fullText, pageCount, updatedAt: idClock.now() })
      .where(eq(pdfs.id, existing.id));

    return {
      id: existing.id,
      fileName,
      pageCount,
      fullText,
      readingState: readingStateOf(existing),
    };
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

  return { id, fileName, pageCount, fullText, readingState: null };
}

/**
 * The place a stored book reports, or null for one nobody has read.
 *
 * A page is what makes a place a place: the highlight and the two panels are
 * things that were open at it, so a row without a page has nothing to return
 * to even if those columns hold something.
 */
function readingStateOf(row: {
  lastReadPage: number | null;
  lastReadSelectionId: string | null;
  lastReadOutlineOpen: boolean | null;
  lastReadChatPanelOpen: boolean | null;
}): ReadingState | null {
  if (row.lastReadPage === null) return null;
  return {
    page: row.lastReadPage,
    selectionId: row.lastReadSelectionId,
    outlineOpen: row.lastReadOutlineOpen,
    chatPanelOpen: row.lastReadChatPanelOpen,
  };
}

/**
 * Save where the reader is, so the next device opens the book there.
 *
 * `updatedAt` is deliberately left alone: the shelf is ordered by it, and
 * turning a page is not opening a book again.
 *
 * An omitted panel keeps whatever is stored. Narrow screens leave both out —
 * their outline is a drawer that closes itself on every jump and their chat a
 * sheet, and saving those would fold away what a wide screen deliberately
 * opened.
 */
export function saveReadingState(
  db: D1Database,
  pdfId: string,
  place: SaveReadingStateRequest,
): ResultAsync<void, ServiceError> {
  return ResultAsync.fromPromise(writeReadingState(db, pdfId, place), storageFailure).andThen(
    (saved) => (saved ? ok(undefined) : err(notFound())),
  );
}

async function writeReadingState(
  db: D1Database,
  pdfId: string,
  place: SaveReadingStateRequest,
): Promise<boolean> {
  const updated = await drizzle(db)
    .update(pdfs)
    .set({
      lastReadPage: place.page,
      lastReadSelectionId: place.selectionId,
      ...(place.outlineOpen === undefined ? {} : { lastReadOutlineOpen: place.outlineOpen }),
      ...(place.chatPanelOpen === undefined ? {} : { lastReadChatPanelOpen: place.chatPanelOpen }),
    })
    .where(eq(pdfs.id, pdfId))
    .returning({ id: pdfs.id })
    .all();

  return updated.length > 0;
}

/**
 * Delete a book together with everything it owns: its selections and chat
 * messages (via the schema's ON DELETE CASCADE) and its R2 objects.
 * D1 is cleared first — if the R2 cleanup then fails, only an unreachable
 * object is left behind, whereas the reverse order would leave a book on the
 * shelf whose binary is gone.
 *
 * "No such book" and "the store refused" both come back as failures now: the
 * old boolean made the first look like a result and left the second to escape
 * as an exception, so the two ends of the same operation were reported in two
 * different ways.
 */
export function deletePdf(
  db: D1Database,
  bucket: R2Bucket,
  pdfId: string,
): ResultAsync<void, ServiceError> {
  return ResultAsync.fromPromise(removePdf(db, bucket, pdfId), storageFailure).andThen((deleted) =>
    deleted ? ok(undefined) : err(notFound()),
  );
}

async function removePdf(db: D1Database, bucket: R2Bucket, pdfId: string): Promise<boolean> {
  const d1Db = drizzle(db);
  const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!pdf) return false;

  await d1Db.delete(pdfs).where(eq(pdfs.id, pdfId));
  await bucket.delete([pdfObjectKey(pdf.fileHash), thumbnailObjectKey(pdf.fileHash)]);

  return true;
}

/**
 * The geometry of a stored highlight.
 *
 * Deliberately forgiving, unlike the endpoint that writes it: rows predating
 * the enforced shape carry the viewer's whole measurement, and one row that
 * cannot be read must not take the book it belongs to down with it. Such a
 * highlight is served without rects, so the book still opens and the passage
 * stays in the list.
 */
function readPositionData(stored: string): PositionData {
  try {
    const parsed = positionDataSchema.safeParse(JSON.parse(stored));
    if (parsed.success) return parsed.data;
  } catch {
    // Not even JSON — fall through to the empty geometry
  }
  return { rects: [] };
}

/**
 * The book's highlights whose passage, or whose chat, holds `query`.
 *
 * One statement rather than two searches merged afterwards: a highlight matched
 * by both would otherwise have to be de-duplicated, and the two halves could
 * land at different times.
 */
export function searchSelections(
  db: D1Database,
  pdfId: string,
  query: string,
): ResultAsync<string[], ServiceError> {
  return ResultAsync.fromPromise(findSelections(db, pdfId, query), storageFailure).andThen(
    (found) => (found ? ok(found) : err(notFound())),
  );
}

/**
 * `%` and `_` are LIKE's own; a reader typing one means the character.
 *
 * Without this a search for "%" answers with the whole book — which reads as
 * the search being broken rather than as a wildcard being honoured.
 */
function likeContaining(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

async function findSelections(
  db: D1Database,
  pdfId: string,
  query: string,
): Promise<string[] | null> {
  const d1Db = drizzle(db);
  const book = await d1Db.select({ id: pdfs.id }).from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!book) return null;

  const needle = likeContaining(query);
  const rows = await db
    .prepare(
      `SELECT s.id FROM selections s
       WHERE s.pdf_id = ?1
         AND (s.selected_text LIKE ?2 ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM chat_messages m
                         WHERE m.selection_id = s.id AND m.content LIKE ?2 ESCAPE '\\'))
       ORDER BY s.created_at DESC`,
    )
    .bind(pdfId, needle)
    .all<{ id: string }>();

  return rows.results.map((row) => row.id);
}

/**
 * Get a PDF record by id, including its selections.
 */
export function getPdf(db: D1Database, bucket: R2Bucket, pdfId: string) {
  return ResultAsync.fromPromise(readPdf(db, bucket, pdfId), storageFailure).andThen((book) =>
    book ? ok(book) : err(notFound()),
  );
}

async function readPdf(db: D1Database, bucket: R2Bucket, pdfId: string) {
  const d1Db = drizzle(db);
  const pdf = await d1Db.select().from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!pdf) return null;

  // Asked for together: the highlights and the cover do not depend on each
  // other, and awaiting them in turn made opening a book wait out two round
  // trips where one would do.
  const [selRows, thumbnail] = await Promise.all([
    d1Db.select().from(selections).where(eq(selections.pdfId, pdfId)).all(),
    bucket.head(thumbnailObjectKey(pdf.fileHash)),
  ]);

  return {
    id: pdf.id,
    fileName: pdf.fileName,
    pageCount: pdf.pageCount,
    hasThumbnail: thumbnail !== null,
    readingState: readingStateOf(pdf),
    selections: selRows.map((s) => ({
      id: s.id,
      selectedText: s.selectedText,
      pageNumber: s.pageNumber,
      positionData: readPositionData(s.positionData),
      color: s.color,
      createdAt: s.createdAt,
    })),
  };
}
