// oxlint-disable-next-line no-restricted-imports -- 開いている本に合わせてハイライトを読み直すために必要
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { selectionsAtom } from "../atoms/chatAtom";
import type { SelectionHighlight } from "../../shared/schemas/selection";
import type { PdfDoc } from "../atoms/pdfAtom";

export type LoadSelections = (pdfId: string) => Promise<SelectionHighlight[]>;

/** Keeps the shared highlights in step with the book currently open. */
export function useHighlights(pdfDoc: PdfDoc | null, loadSelections: LoadSelections) {
  const setSelections = useSetAtom(selectionsAtom);

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    // The atom outlives the viewer, so drop the previous book's highlights
    // instead of showing them over the new one until the load lands.
    setSelections([]);
    loadSelections(pdfDoc.id)
      .then((highlights) => {
        if (!cancelled) setSelections(highlights);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, loadSelections, setSelections]);
}
