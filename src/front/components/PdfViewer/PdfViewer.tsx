// oxlint-disable-next-line no-restricted-imports -- 表示幅の ResizeObserver 購読、ページ遷移時のスクロール位置リセット、document への selectionchange 購読に必要
import { useRef, useState, useCallback, useEffect } from "react";
import { useAtomValue, useAtom } from "jotai";
import { currentPageAtom, pageViewportAtom, outlineOpenAtom } from "../../atoms/pdfAtom";
import type { ActiveSelection } from "../../atoms/chatAtom";
import type { SelectionRect } from "../../../shared/schemas/selection";
import type { BookDetail } from "../../../shared/schemas/book";
import { PdfPage } from "./PdfPage";
import { PdfOutline } from "./PdfOutline";
import { SelectionPopover } from "./SelectionPopover";
import { HighlightOverlay } from "./HighlightOverlay";
import { getSelectionFromTextLayer } from "../../lib/pdfTextMatcher";
import { selectionOnPage, type PageSelection } from "../../lib/selectionRects";
import { usePdfDocument } from "../../hooks/usePdfDocument";
import { usePdfOutline } from "../../hooks/usePdfOutline";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useWebSearchAtom } from "../../atoms/settingsAtom";
import { useAskAboutSelection, type SaveSelection } from "../../hooks/useAskAboutSelection";
import { useHighlights } from "../../hooks/useHighlights";
import type { ViewerAction } from "../../lib/keybindings";

interface PdfViewerProps {
  /** The book being read, or nothing while it is still being read in. */
  book: BookDetail | undefined;
  /** Why the book could not be read, if it could not. */
  bookError: Error | undefined;
  onSelectionClick: (selection: ActiveSelection) => void;
  /**
   * Measures the passage the reader has just dragged over, against the page it
   * is on, into everything the popover needs.
   *
   * Injectable because everything the popover then does — asking, reporting a
   * save that failed, refusing to ask twice — hangs off a real DOM selection
   * inside a page pdf.js has drawn, and jsdom can produce neither. This is the
   * seam those paths are tested through.
   */
  measureSelection?: MeasureSelection;
  /** Stores the highlight; injectable so a failed save can be tested. */
  saveSelection?: SaveSelection;
}

/** The popover the viewer opens over a passage, with everything it needs. */
export interface SelectionPopoverState {
  position: { x: number; y: number; width: number };
  selectedText: string;
  selectionPosition: {
    startIndex: number;
    endIndex: number;
    pageNumber: number;
    rects: SelectionRect[];
    pageWidth: number;
  };
}

export type MeasureSelection = (pageEl: HTMLDivElement | null) => SelectionPopoverState | null;

/**
 * Read the current selection and place it on the page.
 *
 * Rects are measured against the page element rather than the scroll container
 * (which drifts as the reader scrolls), and one rect per line, so a passage
 * spanning several lines is marked as it was drawn.
 */
const measureSelectionOnPage: MeasureSelection = (pageEl) => {
  const passage = getSelectionFromTextLayer();
  // Not a passage — a click on a highlight, say. The popover stays as it is.
  if (!passage) return null;

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !pageEl) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();

  return {
    position: {
      x: rect.left - pageRect.left,
      y: rect.top - pageRect.top,
      width: rect.width,
    },
    selectedText: passage.text,
    selectionPosition: {
      startIndex: passage.startIndex,
      endIndex: passage.endIndex,
      pageNumber: passage.pageNumber,
      rects: selectionOnPage(range, pageEl).rects,
      // Rects are page pixels; without the width they were measured at, the
      // highlight would drift once the page is rendered at another size
      pageWidth: pageRect.width,
    },
  };
};

/** How far j/k move the page, in pixels. A few lines, like vim's line scroll. */
const SCROLL_STEP = 80;

export function PdfViewer({
  book,
  bookError,
  onSelectionClick,
  measureSelection = measureSelectionOnPage,
  saveSelection,
}: PdfViewerProps) {
  const [currentPage, setCurrentPage] = useAtom(currentPageAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const viewport = useAtomValue(pageViewportAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const [popoverState, setPopoverState] = useState<SelectionPopoverState | null>(null);

  const [contentWidth, setContentWidth] = useState(0);
  const [liveSelection, setLiveSelection] = useState<PageSelection | null>(null);

  const [outlineOpen, setOutlineOpen] = useAtom(outlineOpenAtom);

  const { highlights, addHighlight } = useHighlights(book?.id);
  const { pdfDocument, error: documentError } = usePdfDocument(book);
  const { outline, error: outlineError } = usePdfOutline(pdfDocument);
  const { askAboutSelection, saveError } = useAskAboutSelection(addHighlight, saveSelection);
  // Kept with the page it happened on, so turning away from a page that could
  // not be drawn takes its message with it.
  const [renderError, setRenderError] = useState<{ page: number; message: string } | null>(null);
  const reportRenderError = useCallback(
    (message: string) => setRenderError({ page: currentPage, message }),
    [currentPage],
  );

  const pageCount = book?.pageCount ?? 1;
  const handleShortcut = useCallback(
    (action: ViewerAction) => {
      switch (action) {
        case "nextPage":
          setCurrentPage((page) => Math.min(pageCount, page + 1));
          break;
        case "prevPage":
          setCurrentPage((page) => Math.max(1, page - 1));
          break;
        case "firstPage":
          setCurrentPage(1);
          break;
        case "lastPage":
          setCurrentPage(pageCount);
          break;
        case "scrollDown":
          containerRef.current?.scrollBy({ top: SCROLL_STEP });
          break;
        case "scrollUp":
          containerRef.current?.scrollBy({ top: -SCROLL_STEP });
          break;
        case "toggleOutline":
          setOutlineOpen((open) => !open);
          break;
      }
    },
    [pageCount, setCurrentPage, setOutlineOpen],
  );
  useKeyboardShortcuts(handleShortcut);

  // Render the page at whatever width the panel currently has, so dragging the
  // splitter resizes the PDF instead of clipping it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setContentWidth(width));
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pdfDocument]);

  // A page turn swaps the canvas inside this same pane, so the scroll position
  // would carry over and the next page would open part-way down.
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [currentPage]);

  // Draw the selection ourselves while the drag is still in progress. The
  // browser's own selection colour stacks up where pdf.js' spans overlap, which
  // shows as darker bands; drawing it here keeps it even, and identical to what
  // stays on screen once the popover takes focus.
  useEffect(() => {
    let frame = 0;

    const readSelection = () => {
      const selection = document.getSelection();
      const pageEl = pageRef.current;
      if (!pageEl || !selection?.rangeCount || selection.isCollapsed) return null;

      const range = selection.getRangeAt(0);
      return range.intersectsNode(pageEl) ? selectionOnPage(range, pageEl) : null;
    };

    const onSelectionChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLiveSelection(readSelection()));
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  const handleMouseUp = useCallback(() => {
    // The browser has not settled the selection at mouseup time yet
    setTimeout(() => {
      const measured = measureSelection(pageRef.current);
      if (measured) setPopoverState(measured);
    }, 10);
  }, [measureSelection]);

  const handlePopoverSubmit = useCallback(
    async (question: string) => {
      if (!popoverState || !book) return;

      const asked = await askAboutSelection(
        book.id,
        {
          selectedText: popoverState.selectedText,
          pageNumber: popoverState.selectionPosition.pageNumber,
          // The rest of the measurement (the text offsets the passage was
          // found at) is stripped by the endpoint.
          positionData: popoverState.selectionPosition,
        },
        question,
        useWebSearch,
      );

      // Closing on the stored highlight rather than on the answer: the answer
      // takes seconds, and a popover held open for it would sit over the page
      // the whole time. A highlight that was not stored keeps the popover, and
      // the question in it, so the reader can send it again.
      if (asked.isOk()) setPopoverState(null);
    },
    [popoverState, book, askAboutSelection, useWebSearch],
  );

  const handlePopoverDismiss = useCallback(() => {
    setPopoverState(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleHighlightClick = useCallback(
    (selectionId: string) => {
      const hl = highlights.find((h) => h.id === selectionId);
      if (!hl) return;

      // Turning to the page is the caller's job: the chat panel opens
      // highlights of other pages too, and this path only ever sees the
      // current page's highlights.
      onSelectionClick({
        id: hl.id,
        selectedText: hl.selectedText,
        pageNumber: hl.pageNumber,
      });
    },
    [onSelectionClick, highlights],
  );

  return (
    <div className="flex flex-col h-full bg-gray-100" onMouseUp={handleMouseUp}>
      {bookError ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-red-500 text-lg">エラーが発生しました: {bookError.message}</div>
        </div>
      ) : null}

      {documentError !== null ? (
        <div className="flex items-center justify-center flex-1">
          <p role="alert" className="text-red-500 text-lg">
            PDFを表示できません: {documentError}
          </p>
        </div>
      ) : null}

      {!book && !bookError ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-gray-500 text-lg">PDFを読み込み中...</div>
        </div>
      ) : null}

      {saveError !== null ? (
        <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
          ハイライトを保存できませんでした: {saveError}
        </p>
      ) : null}

      {renderError?.page === currentPage ? (
        <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
          このページを表示できません: {renderError.message}
        </p>
      ) : null}

      {/* The page and everything anchored to it. `popoverState` is in the
          condition because the popover is positioned against the page element
          and so has to live inside it: in a browser only a drawn page can
          produce a popover, but a test driving `measureSelection` has no pdf.js
          to draw one with. */}
      {(pdfDocument || popoverState) && (
        <div className="flex min-h-0 flex-1">
          {outlineOpen && (
            // Only reachable once pdf.js has handed over a document, so this
            // wiring of `error` is held by the type checker, not by a test.
            <PdfOutline
              outline={outline}
              error={outlineError}
              currentPage={currentPage}
              onJump={setCurrentPage}
            />
          )}

          <div ref={containerRef} className="flex-1 overflow-auto p-4">
            <div ref={pageRef} className="relative mx-auto" style={{ width: "fit-content" }}>
              {/* Same again: only a drawn page reports a render failure, so
                  `onError` is wired under the type checker's eye alone. */}
              {pdfDocument && contentWidth > 0 && (
                <PdfPage
                  pdfDoc={pdfDocument}
                  pageNumber={currentPage}
                  containerWidth={contentWidth}
                  onError={reportRenderError}
                />
              )}
              <HighlightOverlay
                highlights={highlights}
                pageNumber={currentPage}
                containerWidth={viewport.width}
                containerHeight={viewport.height}
                basePageWidth={viewport.baseWidth}
                pending={
                  popoverState
                    ? {
                        rects: popoverState.selectionPosition.rects,
                        pageWidth: popoverState.selectionPosition.pageWidth,
                      }
                    : liveSelection
                }
                onHighlightClick={handleHighlightClick}
              />

              {popoverState && (
                <div
                  className="absolute z-50 w-80"
                  style={{
                    // Centre on the selection, keep it inside the page, and sit
                    // just above the selected line.
                    left: Math.min(
                      Math.max(0, popoverState.position.x + popoverState.position.width / 2 - 160),
                      Math.max(0, viewport.width - 320),
                    ),
                    top: Math.max(0, popoverState.position.y - 130),
                  }}
                >
                  <SelectionPopover
                    onSubmit={handlePopoverSubmit}
                    onDismiss={handlePopoverDismiss}
                  />
                </div>
              )}
            </div>

            {book && (
              <div className="flex items-center justify-center gap-4 py-4">
                <button
                  type="button"
                  onClick={() => setOutlineOpen((open) => !open)}
                  aria-pressed={outlineOpen}
                  className="px-3 py-1 bg-white border rounded cursor-pointer text-sm text-gray-600 hover:bg-gray-50"
                >
                  {outlineOpen ? "目次を隠す" : "目次を表示"}
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                  className="px-3 py-1 bg-white border rounded disabled:opacity-30 cursor-pointer"
                >
                  前へ
                </button>
                <span className="text-sm text-gray-600">
                  {currentPage} / {book.pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage(Math.min(book.pageCount, currentPage + 1))}
                  disabled={currentPage >= book.pageCount}
                  className="px-3 py-1 bg-white border rounded disabled:opacity-30 cursor-pointer"
                >
                  次へ
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
