// oxlint-disable-next-line no-restricted-imports -- pdf.js の命令的な描画 API (RenderTask / TextLayer) のライフサイクル管理に必要
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { pageViewportAtom } from "../../atoms/pdfAtom";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { pdfjsLib } from "../../lib/pdfjsConfig";
import { guardTextLayerSelection } from "../../lib/textLayerSelectionGuard";

interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  /** Width to fit the page into, so the viewer can be resized freely. */
  containerWidth: number;
  /**
   * Called with the reason this page could not be drawn. A cancelled render is
   * not one: it is the normal path when the page or the width changes.
   */
  onError?: (message: string) => void;
}

export function PdfPage({ pdfDoc, pageNumber, containerWidth, onError }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const releaseSelectionGuard = useRef<(() => void) | null>(null);
  const setViewport = useSetAtom(pageViewportAtom);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;

      const baseWidth = page.getViewport({ scale: 1 }).width;
      const scale = containerWidth / baseWidth;
      const viewport = page.getViewport({ scale });

      // A canvas sized in CSS pixels is upscaled by the display and the text
      // comes out soft. Draw at the screen's real pixel density and let CSS
      // size it back down.
      const pixelRatio = window.devicePixelRatio || 1;
      const deviceViewport = page.getViewport({ scale: scale * pixelRatio });

      // The page is drawn off screen and swapped in once it is complete.
      // Drawing into the visible canvas instead would blank it for as long as
      // the render takes, which reads as a flash on every page turn.
      const offscreen = document.createElement("canvas");
      offscreen.width = deviceViewport.width;
      offscreen.height = deviceViewport.height;

      // A page can only be in one render at a time. React StrictMode runs
      // effects twice, so cancel the in-flight task before starting a new one,
      // otherwise pdf.js throws and everything after it is skipped.
      renderTaskRef.current?.cancel();

      const task = page.render({ canvas: offscreen, viewport: deviceViewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (err) {
        // Cancelling is the normal path on re-render; anything else is real
        if ((err as { name?: string })?.name !== "RenderingCancelledException") throw err;
        return;
      }
      if (cancelled) return;

      const textContent = await page.getTextContent();
      if (cancelled) return;

      const canvas = canvasRef.current;
      const textLayerDiv = textLayerRef.current;
      if (!canvas || !textLayerDiv) return;

      canvas.width = deviceViewport.width;
      canvas.height = deviceViewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.getContext("2d")?.drawImage(offscreen, 0, 0);

      // pdf.js positions text spans relative to this custom property
      textLayerDiv.style.setProperty("--scale-factor", String(scale));
      textLayerDiv.style.width = `${viewport.width}px`;
      textLayerDiv.style.height = `${viewport.height}px`;
      textLayerDiv.replaceChildren();

      // Built straight into the visible container, unlike the canvas above: the
      // text layer is transparent, so staging it elsewhere would buy nothing.
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport,
      });
      await textLayer.render();
      if (cancelled) return;

      // pdfTextMatcher maps a DOM selection back to text item indices
      textLayer.textDivs.forEach((div, index) => {
        div.dataset.textItemIndex = String(index);
        div.dataset.pageNumber = String(pageNumber);
      });

      // Stops a drag that overshoots a line from running on through the rest of
      // the page; see guardTextLayerSelection
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      textLayerDiv.append(endOfContent);
      releaseSelectionGuard.current?.();
      releaseSelectionGuard.current = guardTextLayerSelection(textLayerDiv, endOfContent);

      // Overlays follow the page size, so publish it only once the page is up
      setViewport({ width: viewport.width, height: viewport.height, baseWidth });
    }

    renderPage().catch((err: unknown) => {
      console.error("Failed to render page:", err);
      // A cancelled render never gets here — renderPage returns on it — so
      // anything that does is a page the reader will not see drawn.
      if (!cancelled) onError?.(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      releaseSelectionGuard.current?.();
      releaseSelectionGuard.current = null;
    };
  }, [pdfDoc, pageNumber, containerWidth, setViewport, onError]);

  return (
    <div className="relative mb-4 shadow-lg mx-auto" style={{ width: "fit-content" }}>
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
}
