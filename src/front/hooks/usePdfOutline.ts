// oxlint-disable-next-line no-restricted-imports -- pdf.js の getOutline を呼び、dest をページ番号へ解決する非同期処理に必要
import { useState, useEffect } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface OutlineEntry {
  title: string;
  /** null when the destination cannot be resolved to a page */
  pageNumber: number | null;
  children: OutlineEntry[];
}

type RawOutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

/**
 * Resolve an outline destination to a 1-based page number.
 * A destination is either a name that has to be looked up, or an explicit
 * array whose first element is a page reference.
 */
async function resolvePageNumber(
  doc: PDFDocumentProxy,
  dest: RawOutlineItem["dest"],
): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    return (
      (await doc.getPageIndex(explicit[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1
    );
  } catch {
    return null;
  }
}

async function toEntries(doc: PDFDocumentProxy, items: RawOutlineItem[]): Promise<OutlineEntry[]> {
  return Promise.all(
    items.map(async (item) => ({
      title: item.title,
      pageNumber: await resolvePageNumber(doc, item.dest),
      children: item.items?.length ? await toEntries(doc, item.items as RawOutlineItem[]) : [],
    })),
  );
}

/**
 * Read the PDF's bookmarks (table of contents) and resolve each entry to a page.
 * Returns an empty array for PDFs that ship without an outline.
 *
 * A read that failed is kept apart from a book that has no bookmarks: both used
 * to end as an empty list, so a reader could not tell "this book has no table
 * of contents" from "the one it has could not be read".
 */
export function usePdfOutline(doc: PDFDocumentProxy | null) {
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc) {
      setOutline(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    doc
      .getOutline()
      .then(async (items) => {
        const entries = items ? await toEntries(doc, items) : [];
        if (!cancelled) setOutline(entries);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [doc]);

  return { outline, error };
}
