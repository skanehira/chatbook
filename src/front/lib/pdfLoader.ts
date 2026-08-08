import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfjsLib, PDFJS_ASSET_OPTIONS } from "./pdfjsConfig";

export interface ExtractedPdfData {
  fileName: string;
  fileHash: string;
  fullText: string;
  pageCount: number;
  fileContentBase64: string; // base64 encoded PDF for server upload
  thumbnail: Blob | null; // cover image for the shelf, null if rendering failed
}

const THUMBNAIL_WIDTH = 240;

/**
 * Render the first page as a small webp image to use as the book cover.
 * Returns null when the browser cannot produce the image; the shelf then falls
 * back to a placeholder rather than blocking the upload.
 */
export async function renderCoverThumbnail(doc: PDFDocumentProxy): Promise<Blob | null> {
  try {
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / baseViewport.width });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    await page.render({ canvas, viewport }).promise;

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.8);
    });
  } catch {
    // Deliberately the one failure this app does not report. A cover is
    // decoration: the shelf draws the title in its place, and stopping an
    // upload — or putting an error beside a book that opened perfectly well —
    // over a missing picture would cost the reader more than it tells them.
    return null;
  }
}

/**
 * Compute SHA-256 hash of binary data using Web Crypto.
 */
async function computeHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Load a PDF file, extract text content, compute hash.
 * This is the client-side equivalent of what was originally server-side.
 */
export async function extractPdfData(file: File): Promise<ExtractedPdfData> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // Compute hash in parallel with extraction
  const hashPromise = computeHash(bytes);

  // Load PDF and extract text
  const doc = await pdfjsLib.getDocument({ data: bytes, ...PDFJS_ASSET_OPTIONS }).promise;
  const pageCount = doc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? (item as { str: string }).str : ""))
      .filter(Boolean)
      .join(" ");
    pageTexts.push(pageText);
  }

  const fileHash = await hashPromise;
  const thumbnail = await renderCoverThumbnail(doc);

  return {
    fileName: file.name,
    fileHash,
    // Pages are joined with a form feed so the server can map a quoted passage
    // back to the page it came from (see chatService.findPageNumber)
    fullText: pageTexts.join("\f"),
    pageCount,
    fileContentBase64: bytesToBase64(bytes),
    thumbnail,
  };
}
