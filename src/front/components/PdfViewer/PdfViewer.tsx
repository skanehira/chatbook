// oxlint-disable-next-line no-restricted-imports -- 表示領域の ResizeObserver 購読、ピンチ (ctrlKey wheel) の非 passive な購読、ページ遷移時のスクロール位置リセット、document への selectionchange 購読、pdf.js が描いたテキストレイヤーからの引用箇所の計測、および [MOCK] 読んだ目次をチャットの範囲メニューへ渡す写しに必要
import { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useAtomValue, useAtom, useSetAtom } from "jotai";
import {
  currentPageAtom,
  pageViewportsAtom,
  UNDRAWN_PAGE,
  outlineOpenAtom,
  citedPassageAtom,
  outlineChaptersAtom,
} from "../../atoms/pdfAtom";
import type { ActiveSelection } from "../../atoms/chatAtom";
import type { SelectionRect } from "../../../shared/schemas/selection";
import type { BookDetail } from "../../../shared/schemas/book";
import { PdfPage } from "./PdfPage";
import { PdfOutline } from "./PdfOutline";
import { PageStepper } from "./PageStepper";
import { SelectionPopover } from "./SelectionPopover";
import { SelectionActionBar } from "./SelectionActionBar";
import { HighlightOverlay } from "./HighlightOverlay";
import { getSelectionFromTextLayer } from "../../lib/pdfTextMatcher";
import { rangeWithinPage, selectionOnPage, type PageSelection } from "../../lib/selectionRects";
import { citedPassageOnPage } from "../../lib/citedPassage";
import { usePdfDocument } from "../../hooks/usePdfDocument";
import { usePdfOutline } from "../../hooks/usePdfOutline";
import { toStoredOutline } from "../../lib/pdfOutline";
import { spansFromOutline } from "../../lib/bookChatMock";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useWebSearchAtom, zoomAtomFor } from "../../atoms/settingsAtom";
import { nextZoom } from "../../lib/pageScale";
import { fitsTwoPages, lastSpreadStart, turnTo, visiblePages } from "../../lib/spread";
import { usePageBaseSize } from "../../hooks/usePageBaseSize";
import { pinchZoom, resolveSwipe, resolveTapZone, type PageTurn } from "../../lib/touchNavigation";
import { useAskAboutSelection, type SaveSelection } from "../../hooks/useAskAboutSelection";
import { useHighlights } from "../../hooks/useHighlights";
import { useSettledSelection } from "../../hooks/useSettledSelection";
import { useIsNarrow } from "../../hooks/useIsNarrow";
import type { ViewerAction } from "../../lib/keybindings";

interface PdfViewerProps {
  /**
   * The book being read, from the address the reader followed. Passed apart
   * from `book` so the binary can be fetched while the book itself is still on
   * its way.
   */
  pdfId: string | undefined;
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

/** How far a finger may stray and still have been a tap rather than a drag. */
const TAP_SLOP_PX = 12;

/** Longer than this and the finger was resting on the page, not tapping it. */
const TAP_MAX_MS = 500;

/** How soon a second tap has to land to be read as one gesture with the first. */
const DOUBLE_TAP_MS = 320;

/** What a double tap enlarges to, and what counts as already enlarged. */
const DOUBLE_TAP_ZOOM = 2;
const ENLARGED_ABOVE = 1.05;

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
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !pageEl) return null;

  const range = rangeWithinPage(selection.getRangeAt(0), pageEl);

  const passage = getSelectionFromTextLayer(range);
  // Not a passage — a click on a highlight, say. The popover stays as it is.
  if (!passage) return null;

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

/**
 * Marks the box a page and the overlays laid over it share.
 *
 * Written as `data-page-container` on each page in the tree below; this is the
 * name the lookups here go by.
 */
const PAGE_CONTAINER_ATTR = "data-page-container";

/**
 * The page a node in the drawn text sits on, if it sits on one.
 *
 * Everything measured on a passage — the rectangles stored with the highlight,
 * where the popover is anchored — is measured against the page element it is
 * on. With two pages up, which of them that is has to be read off the DOM
 * rather than taken to be the page the reader is counted as being on.
 */
function pageContainerOf(node: Node | null | undefined): HTMLDivElement | null {
  const from = node instanceof Element ? node : node?.parentElement;
  return from?.closest<HTMLDivElement>(`[${PAGE_CONTAINER_ATTR}]`) ?? null;
}

/** Which page a page element is. */
function pageNumberOf(pageElement: HTMLDivElement): number {
  return Number(pageElement.dataset.pageContainer);
}

/** The page element the current selection starts on, if it starts on one. */
function selectedPageElement(): HTMLDivElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  // Where the reader pressed down, not where the range begins: dragging right
  // to left across a spread anchors on the second page and reaches back onto
  // the first, and a range is always in document order.
  return pageContainerOf(selection.anchorNode ?? selection.getRangeAt(0).startContainer);
}

/** How far j/k move the page, in pixels. A few lines, like vim's line scroll. */
const SCROLL_STEP = 80;

export function PdfViewer({
  pdfId,
  book,
  bookError,
  onSelectionClick,
  measureSelection = measureSelectionOnPage,
  saveSelection,
}: PdfViewerProps) {
  const [currentPage, setCurrentPage] = useAtom(currentPageAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const viewports = useAtomValue(pageViewportsAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);

  /** The box a given page and its overlays are laid out in, once it is up. */
  const pageElementFor = useCallback(
    (page: number) =>
      pagesRef.current?.querySelector<HTMLDivElement>(`[${PAGE_CONTAINER_ATTR}="${page}"]`) ?? null,
    [],
  );

  const [popoverState, setPopoverState] = useState<SelectionPopoverState | null>(null);

  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [liveSelection, setLiveSelection] = useState<
    (PageSelection & { pageNumber: number }) | null
  >(null);

  const citedPassage = useAtomValue(citedPassageAtom);
  const setCitedPassage = useSetAtom(citedPassageAtom);
  const [citedSelection, setCitedSelection] = useState<
    (PageSelection & { pageNumber: number }) | null
  >(null);

  const [outlineOpen, setOutlineOpen] = useAtom(outlineOpenAtom);
  // Kept per book and outside the store, which is thrown away with the book
  const [zoom, setZoom] = useAtom(zoomAtomFor(book?.id ?? ""));

  const { highlights, addHighlight } = useHighlights(book?.id);
  const isNarrow = useIsNarrow();
  /**
   * Whether the question box is up over the passage the bar is offering.
   *
   * Kept apart from `popoverState`, which stays the measured passage either
   * way: the rectangles drawn under the offer are the same ones drawn under the
   * box, and losing them at the moment the box opens would blank the highlight
   * the reader is looking at.
   */
  const [questionOpen, setQuestionOpen] = useState(false);
  /**
   * Whether a finger chose the passage, which decides what is offered on it.
   *
   * Held rather than asked at render time: the pointer that made this selection
   * is the one that matters, and by the time the reader reaches for the offer
   * they may have touched something else.
   */
  const [chosenByFinger, setChosenByFinger] = useState(false);
  /**
   * Whether the offer comes before the question box, rather than the box
   * landing straight on the passage.
   *
   * A finger needs it either way round: the box takes the focus with it, and a
   * selection that loses the focus loses the handles the reader was still
   * adjusting — there is then no way back to widen it. One column needs it too
   * at any pointer, because the box is 320px wide and a phone is not.
   */
  const offerFirst = isNarrow || chosenByFinger;
  const { pdfDocument, error: documentError } = usePdfDocument(pdfId, book);
  const { outline, error: outlineError } = usePdfOutline(pdfDocument);
  const { askAboutSelection, saveError } = useAskAboutSelection(addHighlight, saveSelection);
  // Kept with the page it happened on, so turning away from a page that could
  // not be drawn takes its message with it.
  const [renderError, setRenderError] = useState<{ page: number; message: string } | null>(null);
  const reportRenderError = useCallback(
    (page: number, message: string) => setRenderError({ page, message }),
    [],
  );

  const pageCount = book?.pageCount ?? 1;

  // MOCK: the chat panel's chapter picker reads its list from the store, and
  // nothing serves the stored outline yet — so the copy the viewer already
  // reads for the outline panel is reported up. Deleted with bookChatMock.
  const setOutlineChapters = useSetAtom(outlineChaptersAtom);
  useEffect(() => {
    setOutlineChapters(spansFromOutline(toStoredOutline(outline ?? []), pageCount));
  }, [outline, pageCount, setOutlineChapters]);

  /**
   * Two pages beside each other as soon as the pane has room for both at the
   * size one would be drawn at on its own.
   *
   * Measured rather than asked of the panels: a wide enough window has room for
   * two pages with the outline still beside them, and a phone has room for
   * neither however much is folded away. The reader's zoom counts as part of
   * that size, so shrinking the page can bring a second one up and enlarging it
   * sends that page away again.
   */
  const pageBaseSize = usePageBaseSize(pdfDocument, currentPage);
  const twoUp = pageBaseSize !== null && fitsTwoPages(pageBaseSize, contentSize, zoom);
  /** The pages up at once, left to right. */
  const pagesUp = useMemo(
    () => visiblePages(currentPage, pageCount, twoUp),
    [currentPage, pageCount, twoUp],
  );
  /** How far a page turn moves: as many pages as are up, so the reader is
   * always given pages they have not read. */
  const pageStep = pagesUp.length;

  const handleShortcut = useCallback(
    (action: ViewerAction) => {
      switch (action) {
        case "nextPage":
          setCurrentPage((page) => turnTo(page, "next", pageCount, pageStep));
          break;
        case "prevPage":
          setCurrentPage((page) => turnTo(page, "prev", pageCount, pageStep));
          break;
        case "firstPage":
          setCurrentPage(1);
          break;
        case "lastPage":
          setCurrentPage(lastSpreadStart(pageCount, pageStep));
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
    [pageCount, pageStep, setCurrentPage, setOutlineOpen],
  );
  useKeyboardShortcuts(handleShortcut);

  /**
   * Over the page — the one column layout — the outline covers the page it has
   * just jumped to, so choosing a heading is also leaving the outline. Beside
   * the page it stays, since following a chapter often means picking the next.
   */
  const handleOutlineJump = useCallback(
    (pageNumber: number) => {
      setCurrentPage(pageNumber);
      if (isNarrow) setOutlineOpen(false);
    },
    [isNarrow, setCurrentPage, setOutlineOpen],
  );

  const turnPage = useCallback(
    (turn: PageTurn) => setCurrentPage((page) => turnTo(page, turn, pageCount, pageStep)),
    [pageCount, pageStep, setCurrentPage],
  );

  /**
   * Whether a gesture over the page is the reader navigating.
   *
   * A passage under offer means the gesture belongs to it — swiping the page
   * out from under a highlight about to be stored loses both.
   */
  const turnable = useCallback(() => {
    if (popoverState) return false;
    const selection = window.getSelection();
    return !selection || selection.isCollapsed;
  }, [popoverState]);

  // Read inside listeners that outlive the render they were bound in, so a
  // pinch does not have to re-bind on every frame of itself.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const turnPageRef = useRef(turnPage);
  turnPageRef.current = turnPage;

  // Render the page into whatever area the panel currently has, so dragging the
  // splitter or folding the chat away resizes the PDF instead of clipping it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setContentSize({ width, height }));
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pdfDocument]);

  // A trackpad pinch arrives as a wheel event with ctrlKey set. React attaches
  // its own wheel listener passively, which cannot refuse the browser's page
  // zoom, so this one is bound to the pane directly.
  // A layout effect, not a passive one: the pane is observable the moment it
  // is in the DOM, while a passive effect waits its turn on the scheduler. In
  // that window a pinch is answered by the browser zooming the whole app,
  // which is exactly what taking this listener non-passively is for.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !book) return;

    const zoomOnPinch = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Otherwise the browser zooms the whole app on top of the page
      event.preventDefault();
      setZoom((current) => nextZoom(current, event.deltaY));
    };

    container.addEventListener("wheel", zoomOnPinch, { passive: false });
    return () => container.removeEventListener("wheel", zoomOnPinch);
    // The pane is only in the tree once there is a page or a popover in it
  }, [pdfDocument, popoverState, book, setZoom]);

  /**
   * The same gestures a finger makes: pinching to zoom, swiping and tapping the
   * edges to turn.
   *
   * All of it is bound to the pane directly and non-passively, for the same
   * reason the wheel above is — a listener React attached cannot refuse the
   * browser's own pinch zoom or double-tap zoom. `touch-action: manipulation`
   * on the pane sees off the double-tap zoom; the pinch has to be taken frame
   * by frame, so the pane stops panning for as long as two fingers are down.
   *
   * Safari does not deliver the second finger as a touch to be measured: it
   * reports the whole gesture through its own events, with the ratio already
   * worked out. Both are wired, and neither fires where the other does.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let pinch: { distance: number; zoom: number } | null = null;
    let touch: { x: number; y: number; startedAt: number } | null = null;

    const spread = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    const firstTouch = (touches: TouchList) => touches[0];

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        // A second finger is never a swipe, and never a tap
        touch = null;
        container.style.touchAction = "none";
        pinch = { distance: spread(event.touches), zoom: zoomRef.current };
        event.preventDefault();
        return;
      }
      if (event.touches.length === 1) {
        const first = firstTouch(event.touches);
        touch = { x: first.clientX, y: first.clientY, startedAt: event.timeStamp };
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      setZoom(pinchZoom(pinch.zoom, spread(event.touches) / pinch.distance));
    };

    const endPinch = () => {
      if (!pinch) return;
      pinch = null;
      container.style.touchAction = "";
    };

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = touch;
      touch = null;
      endPinch();
      if (!gesture || !turnable()) return;
      // Enlarged, a finger travelling sideways is moving about the page rather
      // than leaving it — the same reason the edge taps stop turning.
      if (zoomRef.current > ENLARGED_ABOVE) return;

      const last = firstTouch(event.changedTouches);
      const turn = resolveSwipe({
        dx: last.clientX - gesture.x,
        dy: last.clientY - gesture.y,
        durationMs: event.timeStamp - gesture.startedAt,
      });
      if (turn) turnPageRef.current(turn);
    };

    // Safari reports a pinch as a gesture of its own, not as two touches
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      touch = null;
      pinch = { distance: 1, zoom: zoomRef.current };
    };
    const onGestureChange = (event: Event) => {
      if (!pinch) return;
      event.preventDefault();
      setZoom(pinchZoom(pinch.zoom, (event as Event & { scale: number }).scale));
    };

    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", endPinch);
    container.addEventListener("gesturestart", onGestureStart, { passive: false });
    container.addEventListener("gesturechange", onGestureChange, { passive: false });
    container.addEventListener("gestureend", endPinch);

    return () => {
      container.style.touchAction = "";
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", endPinch);
      container.removeEventListener("gesturestart", onGestureStart);
      container.removeEventListener("gesturechange", onGestureChange);
      container.removeEventListener("gestureend", endPinch);
    };
  }, [pdfDocument, popoverState, book, setZoom, turnable]);

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
      if (!selection?.rangeCount || selection.isCollapsed) return null;

      const pageEl = selectedPageElement();
      if (!pageEl) return null;

      const range = rangeWithinPage(selection.getRangeAt(0), pageEl);
      return { pageNumber: pageNumberOf(pageEl), ...selectionOnPage(range, pageEl) };
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

  // Find the quoted lines on the page the citation named and mark them. The
  // page they are on is drawn asynchronously, so this waits on `viewport`,
  // which PdfPage republishes each time it has finished laying out a page —
  // that is also what re-measures the mark when the panel is resized.
  useEffect(() => {
    if (!citedPassage) {
      setCitedSelection(null);
      return;
    }

    // Reading on ends the mark. The two atoms are written together when a
    // citation is followed, so a page that is no longer up means the reader has
    // turned away from the passage since.
    if (!pagesUp.includes(citedPassage.pageNumber)) {
      setCitedPassage(null);
      return;
    }

    const pageEl = pageElementFor(citedPassage.pageNumber);
    const found = pageEl ? citedPassageOnPage(pageEl, citedPassage) : null;
    setCitedSelection(found ? { pageNumber: citedPassage.pageNumber, ...found } : null);
  }, [citedPassage, pagesUp, viewports, setCitedPassage, pageElementFor]);

  /**
   * The edges of the page turn it, and the middle is left for the double tap
   * that zooms.
   *
   * Read from pointer events rather than laid over the page as tappable strips:
   * strips that take taps also take the passage under them out of reach, and
   * selecting a passage is what the reader came for.
   */
  const tapRef = useRef<{ x: number; y: number; at: number; turnable: boolean } | null>(null);
  const lastTapRef = useRef(0);

  /**
   * Whether a page turn was on offer is decided here, when the press lands —
   * not when it comes up.
   *
   * Dismissing the question box is a press outside it, and the box closes on
   * `mousedown`, which arrives first. Asked at `pointerup`, this would find
   * nothing under offer any more and turn the page the reader was only trying
   * to get back to.
   */
  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      tapRef.current = {
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        turnable: turnable(),
      };
    },
    [turnable],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      const start = tapRef.current;
      tapRef.current = null;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
      if (event.timeStamp - start.at > TAP_MAX_MS) return;
      // The second press of a double click is a word being selected, not a
      // second page turn asked for
      if (event.detail > 1) return;
      // A highlight, or anything else that can be pressed, answers for itself
      if ((event.target as Element).closest("button")) return;
      if (!start.turnable) return;

      const container = containerRef.current;
      if (!container) return;
      const pane = container.getBoundingClientRect();
      const zone = resolveTapZone((event.clientX - pane.left) / pane.width);

      if (zone === "zoom") {
        // A mouse has the wheel for this, and a double click in the middle of a
        // page suddenly reading 200% is a surprise nobody asked for.
        if (event.pointerType === "mouse") return;

        if (event.timeStamp - lastTapRef.current < DOUBLE_TAP_MS) {
          lastTapRef.current = 0;
          setZoom((current) => (current > ENLARGED_ABOVE ? 1 : DOUBLE_TAP_ZOOM));
        } else {
          lastTapRef.current = event.timeStamp;
        }
        return;
      }

      // Enlarged, the reader is moving about one page rather than leaving it,
      // and an edge they are trying to reach is not a page turn.
      if (zoomRef.current > ENLARGED_ABOVE) return;
      turnPage(zone);
    },
    [turnable, turnPage, setZoom],
  );

  /**
   * The passage the reader has settled on, whatever they chose it with.
   *
   * Read from the browser announcing the selection rather than from `mouseup`,
   * at every window size. A finger never lets a mouse button go, and a tablet
   * is a finger on a wide screen — reading it off `mouseup` worked for a mouse
   * and for nothing else.
   *
   * Silent while the question box is up: focusing its field collapses the
   * selection, and answering that by taking the passage away would close the
   * box the reader just opened.
   */
  useSettledSelection(
    useCallback(
      (pointerType: string | null) => {
        const measured = measureSelection(selectedPageElement());
        if (!measured) return;
        setPopoverState(measured);
        setChosenByFinger(pointerType === "touch");
      },
      [measureSelection],
    ),
    { enabled: !questionOpen },
  );

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
      if (asked.isOk()) {
        setPopoverState(null);
        setQuestionOpen(false);
      }
    },
    [popoverState, book, askAboutSelection, useWebSearch],
  );

  const handlePopoverDismiss = useCallback(() => {
    setPopoverState(null);
    setQuestionOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  /**
   * Closing the question box leaves the passage selected and the offer up: the
   * reader changed their mind about typing, not about the passage.
   */
  const handleQuestionClose = useCallback(() => setQuestionOpen(false), []);

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

  /** How large a page came out, or what it is taken to be before it is drawn. */
  const viewportOf = (page: number) => viewports[page] ?? UNDRAWN_PAGE;

  /**
   * The passage being chosen or asked about, on the page it was taken from.
   *
   * The popover's copy wins while it is up: the browser's own selection is
   * collapsed as soon as the question box takes the focus.
   */
  const pendingOn = (page: number) => {
    if (popoverState) {
      return popoverState.selectionPosition.pageNumber === page
        ? {
            rects: popoverState.selectionPosition.rects,
            pageWidth: popoverState.selectionPosition.pageWidth,
          }
        : null;
    }
    return liveSelection?.pageNumber === page ? liveSelection : null;
  };

  return (
    // `relative` anchors the offer and the question box a touch reader gets to
    // the pane, which ends above the toolbar, rather than to the page inside it.
    <div className="relative flex flex-col h-full bg-gray-100">
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

      {/* Up until there is something to look at. A book that was just uploaded
          is already in the cache, so `book` alone would take this away while
          the binary was still on its way and leave an empty pane in its place.
          `popoverState` mirrors the condition the page is drawn under below. */}
      {!bookError && documentError === null && !(pdfDocument || popoverState) ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-gray-500 text-lg">PDFを読み込み中...</div>
        </div>
      ) : null}

      {saveError !== null ? (
        <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
          ハイライトを保存できませんでした: {saveError}
        </p>
      ) : null}

      {renderError && pagesUp.includes(renderError.page) ? (
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
        <div className="relative flex min-h-0 flex-1">
          {outlineOpen &&
            // Only reachable once pdf.js has handed over a document, so this
            // wiring of `error` is held by the type checker, not by a test.
            (isNarrow ? (
              // On one column the outline arrives over the page instead of
              // beside it: 240px of a phone's width is most of the page.
              <>
                <button
                  type="button"
                  aria-label="目次を閉じる"
                  onClick={() => setOutlineOpen(false)}
                  className="absolute inset-0 z-20 bg-black/40"
                />
                <div className="absolute inset-y-0 left-0 z-30 flex shadow-xl">
                  <PdfOutline
                    outline={outline}
                    error={outlineError}
                    currentPage={currentPage}
                    onJump={handleOutlineJump}
                  />
                </div>
              </>
            ) : (
              <PdfOutline
                outline={outline}
                error={outlineError}
                currentPage={currentPage}
                onJump={handleOutlineJump}
              />
            ))}

          {/* `touch-manipulation` turns off the browser's own double-tap zoom,
              which the viewer answers with its own; the pinch is taken frame by
              frame by the listeners above.

              The gutter is only above and below. A page is taller than it is
              wide, so a pane narrower than those proportions runs out of width
              first and leaves the rest of its height empty — and every pixel
              held at the sides is height the page does not get. Reading is
              scrolling by page, so that height is what the reader misses. */}
          <div
            ref={containerRef}
            className="flex-1 overflow-auto py-4 touch-manipulation"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          >
            <div
              ref={pagesRef}
              className="mx-auto flex items-start gap-2"
              style={{ width: "fit-content" }}
            >
              {pagesUp.map((page) => {
                const drawnAt = viewportOf(page);

                return (
                  // Everything belonging to one page hangs off its own box: the
                  // overlays are laid over it, and every rectangle under them
                  // was measured against it.
                  <div key={page} data-page-container={page} className="relative">
                    {/* Same again: only a drawn page reports a render failure,
                        so `onError` is wired under the type checker's eye
                        alone. */}
                    {pdfDocument && contentSize.width > 0 && contentSize.height > 0 && (
                      <PdfPage
                        pdfDoc={pdfDocument}
                        pageNumber={page}
                        containerWidth={contentSize.width}
                        containerHeight={contentSize.height}
                        zoom={zoom}
                        onError={reportRenderError}
                      />
                    )}
                    <HighlightOverlay
                      highlights={highlights}
                      pageNumber={page}
                      containerWidth={drawnAt.width}
                      containerHeight={drawnAt.height}
                      basePageWidth={drawnAt.baseWidth}
                      pending={pendingOn(page)}
                      cited={citedSelection?.pageNumber === page ? citedSelection : null}
                      onHighlightClick={handleHighlightClick}
                    />

                    {/* Anchored to the passage where a mouse put it. A finger is
                        offered the bar along the bottom of the pane instead,
                        below, and so is one column at any pointer. */}
                    {popoverState &&
                      !offerFirst &&
                      popoverState.selectionPosition.pageNumber === page && (
                        <div
                          className="absolute z-50 w-80"
                          style={{
                            // Centre on the selection, keep it inside the page,
                            // and sit just above the selected line.
                            left: Math.min(
                              Math.max(
                                0,
                                popoverState.position.x + popoverState.position.width / 2 - 160,
                              ),
                              Math.max(0, drawnAt.width - 320),
                            ),
                            top: Math.max(0, popoverState.position.y - 130),
                          }}
                        >
                          <SelectionPopover
                            quote={popoverState.selectedText}
                            onSubmit={handlePopoverSubmit}
                            onDismiss={handlePopoverDismiss}
                          />
                        </div>
                      )}
                  </div>
                );
              })}
            </div>

            {/* Two panes and a finger — a tablet — is the one reader this row is
                for. One column holds the same three controls at the bottom of
                the window instead (`PageToolbar`), so this row would be a second
                copy of them; and a reader who hovers turns pages at the edges of
                the page and with h / l, and never asked which page they are on.
                Hidden by what the device can do rather than by how wide it is,
                the way the shelf's delete button is shown by it: a tablet is as
                wide as a laptop, so a width cannot tell them apart. Folding the
                panels is the header's job at this width. */}
            {book && !isNarrow && (
              <div className="flex items-center justify-center py-4 [@media(hover:hover)]:hidden">
                <PageStepper pageCount={book.pageCount} step={pageStep} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* What a touch reader gets instead of the popover: the offer along the
          bottom of the pane, and the question box only once it is taken. Both
          sit above the page rather than in it, so neither moves with a scroll
          the reader makes while deciding. */}
      {offerFirst && popoverState && !questionOpen && (
        <SelectionActionBar
          quote={popoverState.selectedText}
          onAsk={() => setQuestionOpen(true)}
          onDismiss={handlePopoverDismiss}
        />
      )}

      {offerFirst && popoverState && questionOpen && (
        <div className="absolute inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-gray-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-6px_24px_rgba(19,26,41,0.18)]">
          <SelectionPopover
            quote={popoverState.selectedText}
            onSubmit={handlePopoverSubmit}
            onDismiss={handleQuestionClose}
            floating={false}
          />
        </div>
      )}
    </div>
  );
}
