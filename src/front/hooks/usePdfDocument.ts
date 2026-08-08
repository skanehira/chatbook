// oxlint-disable-next-line no-restricted-imports -- PDF バイナリを取得して pdf.js のドキュメントを構築する初期化処理に必要
import { useState, useEffect, useRef } from "react";
import useSWRMutation from "swr/mutation";
import type * as pdfjsTypes from "pdfjs-dist";
import type { PdfDoc } from "../atoms/pdfAtom";
import { pdfjsLib, PDFJS_ASSET_OPTIONS } from "../lib/pdfjsConfig";
import { renderCoverThumbnail } from "../lib/pdfLoader";
import { fetcher } from "../lib/fetcher";
import { bookDetailSchema, thumbnailStoredSchema } from "../../shared/schemas/book";

/** Where a book's cover is written, and the key the write is tracked under. */
const coverKey = (pdfId: string) => `/api/pdf/${pdfId}/thumbnail`;

/**
 * Books opened before covers existed have no thumbnail in storage. The reader
 * already holds the rendered document, so generate the cover here and store it
 * once; otherwise those books would stay blank on the shelf forever.
 *
 * A book that already has a cover is left alone, so this costs one read for
 * every book but a write only for the ones that predate covers.
 */
export async function storeCoverIfMissing(
  pdfId: string,
  doc: pdfjsTypes.PDFDocumentProxy,
  fetchFn: typeof fetch,
) {
  try {
    const book = await fetcher(`/api/pdf/${pdfId}`, bookDetailSchema, undefined, fetchFn);
    if (book.hasThumbnail) return;

    const thumbnail = await renderCoverThumbnail(doc);
    if (!thumbnail) return;

    await fetcher(
      coverKey(pdfId),
      thumbnailStoredSchema,
      {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: thumbnail,
      },
      fetchFn,
    );
  } catch (err) {
    console.warn("Failed to backfill the book cover (non-critical):", err);
  }
}

/**
 * Load the pdfjs-dist PDFDocumentProxy for the given book by fetching the
 * stored PDF binary from the API.
 */
export function usePdfDocument(pdfDoc: PdfDoc | null, fetchFn: typeof fetch = fetch) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsTypes.PDFDocumentProxy | null>(null);
  const loadingRef = useRef<string | null>(null);

  // Storing a cover is a write, so it is triggered from the document being
  // ready rather than being an effect of its own.
  const { trigger: backfillCover } = useSWRMutation(
    pdfDoc ? coverKey(pdfDoc.id) : null,
    (_key: string, { arg }: { arg: { pdfId: string; doc: pdfjsTypes.PDFDocumentProxy } }) =>
      storeCoverIfMissing(arg.pdfId, arg.doc, fetchFn),
  );

  useEffect(() => {
    if (!pdfDoc) {
      setPdfDocument(null);
      return;
    }

    // Don't reload if already loaded for this doc id
    if (loadingRef.current === pdfDoc.id && pdfDocument) return;
    loadingRef.current = pdfDoc.id;

    const pdfId = pdfDoc.id;
    let cancelled = false;

    async function loadPdf() {
      try {
        const response = await fetchFn(`/api/pdf/${pdfId}/file`);
        if (!response.ok) {
          console.warn("PDF file not found on server, rendering unavailable");
          return;
        }
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;

        const doc = await pdfjsLib.getDocument({
          data: arrayBuffer,
          ...PDFJS_ASSET_OPTIONS,
        }).promise;
        if (cancelled) return;

        setPdfDocument(doc);
        void backfillCover({ pdfId, doc });
      } catch (err) {
        console.error("Failed to load PDF for rendering:", err);
      }
    }

    // Errors are handled inside loadPdf; nothing here awaits it
    void loadPdf();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc?.id]);

  return { pdfDocument };
}
