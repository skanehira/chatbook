// oxlint-disable-next-line no-restricted-imports -- PDF バイナリを取得して pdf.js のドキュメントを構築する初期化処理に必要
import { useState, useEffect, useRef } from "react";
import useSWRMutation from "swr/mutation";
import type * as pdfjsTypes from "pdfjs-dist";
import { pdfjsLib, PDFJS_ASSET_OPTIONS } from "../lib/pdfjsConfig";
import { renderCoverThumbnail } from "../lib/pdfLoader";
import { fetcher, readRefusal } from "../lib/fetcher";
import { thumbnailStoredSchema, type BookDetail } from "../../shared/schemas/book";

/** Where a book's cover is written, and the key the write is tracked under. */
const coverKey = (pdfId: string) => `/api/pdf/${pdfId}/thumbnail`;

/**
 * Books opened before covers existed have no thumbnail in storage. The reader
 * already holds the rendered document, so generate the cover here and store it
 * once; otherwise those books would stay blank on the shelf forever.
 *
 * Whether the book has one is passed in rather than read here: the caller is
 * already holding the book, and asking for it again would be a second request
 * for something this app has in hand.
 */
export async function storeCoverIfMissing(
  pdfId: string,
  doc: pdfjsTypes.PDFDocumentProxy,
  hasThumbnail: boolean,
  fetchFn: typeof fetch,
  renderCover: (doc: pdfjsTypes.PDFDocumentProxy) => Promise<Blob | null> = renderCoverThumbnail,
) {
  if (hasThumbnail) return;

  try {
    const thumbnail = await renderCover(doc);
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
 *
 * A book whose binary is gone, or whose bytes pdf.js will not open, used to
 * leave the viewer with no document and nothing said about it — the reader saw
 * a book that opened to a blank page. `error` is that reason, worded for them.
 */
export function usePdfDocument(book: BookDetail | undefined, fetchFn: typeof fetch = fetch) {
  const [pdfDocument, setPdfDocument] = useState<pdfjsTypes.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef<string | null>(null);

  // Storing a cover is a write, so it goes through a mutation rather than an
  // effect of its own. It is still triggered from the effect below because the
  // event it answers to is pdf.js finishing the document — there is no reader
  // action behind it.
  const { trigger: backfillCover } = useSWRMutation(
    book ? coverKey(book.id) : null,
    (
      _key: string,
      {
        arg,
      }: {
        arg: { pdfId: string; doc: pdfjsTypes.PDFDocumentProxy; hasThumbnail: boolean };
      },
    ) => storeCoverIfMissing(arg.pdfId, arg.doc, arg.hasThumbnail, fetchFn),
  );

  useEffect(() => {
    if (!book) {
      setPdfDocument(null);
      return;
    }

    // Don't reload if already loaded for this doc id
    if (loadingRef.current === book.id && pdfDocument) return;
    loadingRef.current = book.id;

    const pdfId = book.id;
    const hasThumbnail = book.hasThumbnail;
    const url = `/api/pdf/${pdfId}/file`;
    let cancelled = false;
    setError(null);

    async function loadPdf() {
      try {
        const response = await fetchFn(url);
        if (!response.ok) {
          const refusal = await readRefusal(url, response);
          if (!cancelled) setError(`PDFを表示できません: ${refusal.message}`);
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
        void backfillCover({ pdfId, doc, hasThumbnail });
      } catch (cause) {
        // Everything from here on is pdf.js refusing the bytes or the request
        // never arriving; both leave the reader with nothing to look at.
        console.error("Failed to load PDF for rendering:", cause);
        if (!cancelled) {
          setError(
            `PDFを表示できません: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }

    // Errors are handled inside loadPdf; nothing here awaits it
    void loadPdf();

    return () => {
      cancelled = true;
    };
  }, [book?.id]);

  return { pdfDocument, error };
}
