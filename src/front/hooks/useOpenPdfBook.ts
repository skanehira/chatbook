import { useSWRConfig } from "swr";
import { ResultAsync } from "neverthrow";
import { extractPdfData, type ExtractedPdfData } from "../lib/pdfLoader";
import { resultFetcher, putWithProgress } from "../lib/fetcher";
import { bookKey } from "./useBook";
import { rememberUploadedFile } from "../lib/uploadedFileHandoff";
import {
  pdfMetadataSchema,
  thumbnailStoredSchema,
  type BookDetail,
  type PdfMetadata,
} from "../../shared/schemas/book";
import {
  uploadInitResponseSchema,
  uploadedPartSchema,
  textStoredSchema,
  type UploadedPart,
} from "../../shared/schemas/upload";

/** Whatever was thrown, as something with a `message` the reader can be shown. */
const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

/** Turns a file the reader chose into a stored book, and hands back its id. */
export type OpenPdfBook = (file: File) => ResultAsync<string, Error>;

/**
 * One request's worth of a book's binary. A single POST carrying the whole
 * file hits Cloudflare's request body ceiling well before a real technical
 * book does (413, long before "too large to read" is a reasonable thing to
 * tell a reader) — chunking is what lets a book of any size through.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Uploads `file` to R2 as an already-begun multipart upload, `CHUNK_SIZE` at a
 * time, reporting the running count of bytes that have gone up so the caller
 * can turn it into a share of the whole.
 */
async function uploadPdfInParts(
  fileHash: string,
  uploadId: string,
  file: File,
  onProgress: (loaded: number) => void,
  createRequest?: () => XMLHttpRequest,
): Promise<UploadedPart[]> {
  const parts: UploadedPart[] = [];
  const totalParts = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  for (let index = 0; index < totalParts; index++) {
    const partNumber = index + 1;
    const chunkStart = index * CHUNK_SIZE;
    const chunk = file.slice(chunkStart, Math.min(file.size, chunkStart + CHUNK_SIZE));
    const uploaded = await putWithProgress(
      `/api/pdf/uploads/${fileHash}/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      uploadedPartSchema,
      chunk,
      (loaded) => onProgress(chunkStart + loaded),
      createRequest,
    );
    if (uploaded.isErr()) throw uploaded.error;
    parts.push(uploaded.value);
  }

  return parts;
}

/**
 * Sends the book's binary and its extracted text to R2 directly and files the
 * result with D1 — the same trip a single `POST /api/pdf/open` used to make,
 * spread across requests small enough for a book of any size to survive.
 *
 * Only the binary is chunked. A book's worth of extracted text tops out in
 * the low megabytes even at a thousand pages, so it goes up as one PUT rather
 * than through R2's multipart dance a second time.
 */
async function uploadViaR2(
  file: File,
  extracted: ExtractedPdfData,
  onProgress: (ratio: number) => void,
  fetchFn: typeof fetch,
  createRequest?: () => XMLHttpRequest,
): Promise<PdfMetadata> {
  const init = await resultFetcher(
    "/api/pdf/uploads/init",
    uploadInitResponseSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileHash: extracted.fileHash }),
    },
    fetchFn,
  );
  if (init.isErr()) throw init.error;

  const textBlob = new Blob([extracted.fullText], { type: "text/plain;charset=utf-8" });
  const [, pdfParts] = await Promise.all([
    (async () => {
      const stored = await resultFetcher(
        `/api/pdf/uploads/${extracted.fileHash}/text`,
        textStoredSchema,
        { method: "PUT", body: textBlob },
        fetchFn,
      );
      if (stored.isErr()) throw stored.error;
    })(),
    uploadPdfInParts(
      extracted.fileHash,
      init.value.pdfUploadId,
      file,
      (loaded) => onProgress(file.size > 0 ? loaded / file.size : 1),
      createRequest,
    ),
  ]);

  const completed = await resultFetcher(
    "/api/pdf/uploads/complete",
    pdfMetadataSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        fileHash: extracted.fileHash,
        pageCount: extracted.pageCount,
        pdfUploadId: init.value.pdfUploadId,
        pdfParts,
      }),
    },
    fetchFn,
  );
  if (completed.isErr()) throw completed.error;

  return completed.value;
}

/**
 * Stores the rendered cover, if there is one. Failing to store it is not
 * failing to open the book — the shelf falls back to the title — so this
 * reports only whether the reader now has a cover, not why it might not.
 */
async function uploadThumbnail(
  pdfId: string,
  thumbnail: Blob | null,
  fetchFn: typeof fetch,
): Promise<boolean> {
  if (!thumbnail) return false;
  const stored = await resultFetcher(
    `/api/pdf/${pdfId}/thumbnail`,
    thumbnailStoredSchema,
    { method: "PUT", headers: { "Content-Type": "image/webp" }, body: thumbnail },
    fetchFn,
  );
  return stored.isOk();
}

/**
 * Reads a chosen PDF, stores it, and seeds the cache the reader opens it from.
 *
 * A hook rather than a plain function because the last step writes to the SWR
 * cache. The reason a file did not become a book comes back in the value:
 * whoever called this is an event handler, the end of the line for a rejected
 * promise — not even the route's errorElement would catch one — and the reader
 * would be left with a picker that appeared to do nothing.
 */
export function useOpenPdfBook(
  extract: (file: File) => Promise<ExtractedPdfData> = extractPdfData,
  onProgress: (ratio: number) => void = () => {},
  createRequest?: () => XMLHttpRequest,
  fetchFn: typeof fetch = fetch,
): OpenPdfBook {
  const { mutate } = useSWRConfig();

  return (file: File) =>
    // Reading the file is pdf.js' job and can fail on its own (a file that is
    // not really a PDF), so it is part of the same result as the upload.
    ResultAsync.fromPromise(extract(file), asError)
      .andThen((extracted) =>
        ResultAsync.fromPromise(
          uploadViaR2(file, extracted, onProgress, fetchFn, createRequest),
          asError,
        ).map((metadata) => ({ metadata, extracted })),
      )
      .andThen(({ metadata, extracted }) =>
        ResultAsync.fromPromise(
          uploadThumbnail(metadata.id, extracted.thumbnail, fetchFn),
          asError,
        ).map((hasThumbnail) => ({ metadata, hasThumbnail })),
      )
      .andThen(({ metadata, hasThumbnail }) => {
        // The upload already answered with everything the reader needs to open
        // the book, so hand it to the cache the reader reads from. Without this
        // the reader would show an empty viewer while it asked for the very
        // thing that was just sent.
        //
        // The highlight list starts empty because the upload does not report
        // one. Opening a book that was annotated before therefore shows its
        // highlights a moment late, when the reader's own read of the book
        // lands on top of this entry.
        const book: BookDetail = {
          id: metadata.id,
          fileName: metadata.fileName,
          pageCount: metadata.pageCount,
          hasThumbnail,
          selections: [],
          // The place travels with the upload's answer, so a book that was read
          // on another device opens where it was left rather than at page 1.
          readingState: metadata.readingState,
        };
        // The same reasoning as the cache seed, for the bytes rather than the
        // book: the viewer this navigates to would otherwise ask the API for
        // the very file that has just gone up, which over a phone's connection
        // costs the upload all over again.
        rememberUploadedFile(metadata.id, file);

        return ResultAsync.fromPromise(
          mutate(bookKey(metadata.id), book, { revalidate: false }),
          asError,
        ).map(() => metadata.id);
      });
}
