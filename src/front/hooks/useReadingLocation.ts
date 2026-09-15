// oxlint-disable-next-line no-restricted-imports -- 読書位置を URL (外部状態) へ同期し、SWR が解決したページを共有ストアへ反映するために必要
import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router";
import useSWRImmutable from "swr/immutable";
import { currentPageAtom, outlineOpenAtom } from "../atoms/pdfAtom";
import { useIsNarrow } from "./useIsNarrow";
import { activeSelectionAtom, chatPanelOpenAtom, type ActiveSelection } from "../atoms/chatAtom";
import type { BookDetail, LocatedPage, PageMiss } from "../../shared/schemas/book";

/** Resolves a quoted passage to the page it appears on, or why it has none. */
export type LocatePassage = (pdfId: string, passage: string) => Promise<LocatedPage>;

/** What the reader is told when a link named a passage the book will not open at. */
export type PassageMiss = PageMiss | "lookup-failed";

/** Puts the chat about a highlight on screen, with whatever was asked before. */
export type OpenChat = (selection: ActiveSelection) => void;

/** Puts the book's own conversation on screen, with whatever was asked before. */
export type OpenBookChat = () => void;

const PAGE_PARAM = "page";
const SELECTION_PARAM = "selection";

/**
 * Parameters older links still carry, swept out of every URL this hook writes.
 *
 * Both panels were once spelled out here. They are the book's now, so what an
 * old link says about them is stale rather than authoritative — leaving it in
 * the address bar would go on being shared and reopened.
 */
const RETIRED_PARAMS = ["panel", "outline"];

/** Nothing is missing until a link named a passage and the answer is in. */
function missOf(
  linkedPassage: string | null,
  linkedPage: LocatedPage | undefined,
  locateError: unknown,
): PassageMiss | null {
  if (linkedPassage === null) return null;
  if (locateError !== undefined) return "lookup-failed";
  if (linkedPage === undefined || linkedPage.found) return null;
  return linkedPage.miss;
}

const FIRST_PAGE = 1;

function parsePage(value: string | null): number | null {
  const page = Number(value);
  return Number.isInteger(page) && page >= FIRST_PAGE ? page : null;
}

/**
 * Whether the URL names the place to open at, rather than leaving it to the book.
 *
 * A book opened from the shelf carries none of it: no page, no chat, no quoted
 * passage. Anything else names a place the reader asked for — a reload, a link
 * someone shared — and naming one is how the URL keeps the last word over the
 * place the server remembers.
 */
function urlNamesAPlace(params: URLSearchParams, linkedPassage: string | null): boolean {
  return (
    parsePage(params.get(PAGE_PARAM)) !== null ||
    params.get(SELECTION_PARAM) !== null ||
    linkedPassage !== null
  );
}

/**
 * Keep the page being read and the chat open on it in sync with the URL, and
 * take up the place the book was left at when the URL names none.
 *
 * This hook owns every parameter of the reader's URL, and is the only thing that
 * writes them. `setSearchParams` does not merge within a commit, so a second
 * writer working from its own copy of the query would drop whatever the first
 * one had just put there — and one handler moves the page and the chat at once.
 *
 * The reader's own state is the single source of truth: the URL is read once per
 * book and written on every change. Watching the URL as well would make the
 * two effects feed each other, and the reader would bounce between pages.
 *
 * A `#:~:text=` fragment — what Chrome's "Copy link to highlight" writes — wins
 * over `?page=`, since it names the passage the reader actually wants.
 *
 * `passageMiss` is how a link that named a passage but did not deliver it says
 * so, and which of the reasons it was: the book opens on page 1 either way, and
 * a quote that is nowhere in the book means something different to the reader
 * than a book of one page or a lookup that never answered.
 *
 * The chat named by the URL can only be reopened once `book` arrives, since the
 * highlight it is about is read out of it. `openChat` is the reader's own opener,
 * so a restored chat is the same thing as one picked off the list.
 *
 * The two panels are not in the URL at all: whether the outline and the chat sat
 * beside the page is the book's own answer, taken from `readingState` however
 * the book was opened. A URL that names no place at all — a book opened from the
 * shelf — takes the page and the chat from there too, which is how a book put
 * down on one device is picked up on another.
 *
 * `locationReady` says the reader's place has settled, one way or the other. It
 * is what keeps the saver from writing page 1 and the width's own idea of the
 * panels over the place still being restored.
 */
export function useReadingLocation(
  pdfId: string | undefined,
  locatePassage: LocatePassage,
  linkedPassage: string | null,
  book: BookDetail | undefined,
  openChat: OpenChat,
  openBookChat: OpenBookChat,
): { passageMiss: PassageMiss | null; locationReady: boolean } {
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentPage, setCurrentPage] = useAtom(currentPageAtom);
  const activeSelectionId = useAtomValue(activeSelectionAtom)?.id ?? null;
  // Read only to tell whether the reader has moved them, never to write the URL
  // — the panels are not in it, and depending on them there would re-run the
  // writer on every toggle.
  const [outlineOpen, setOutlineOpen] = useAtom(outlineOpenAtom);
  const [chatPanelOpen, setChatPanelOpen] = useAtom(chatPanelOpenAtom);
  const isNarrow = useIsNarrow();

  // The chat this book was opened at, until the book itself arrives and says
  // whether that highlight is still in it. Holding it in state rather than a ref
  // is what re-runs the write below once it clears, so a URL naming a highlight
  // the book has lost stops claiming so.
  const [pendingSelectionId, setPendingSelectionId] = useState<string | null>(null);

  // Whether this book is still waiting on what the server remembers. It comes
  // down once, on the first book that arrives: the book is refetched while it is
  // open — saving a highlight does it — and restoring on each of those would
  // fold away a panel the reader had just opened.
  const [pendingRestore, setPendingRestore] = useState(true);

  // Whether the URL named the place to open at, written by the first effect
  // below on every book and read by the two after it.
  const urlNamesPlace = useRef(false);

  // Whether the URL named a highlight's chat, which is the one conversation it
  // can name. Read by the restore below: the book's own is taken from the book
  // only where the reader did not follow a link to a passage's.
  const urlNamesAChat = useRef(false);

  // The panels as this book was opened, against which "did the reader move one"
  // is judged. The header's toggles do not wait for the book, so this is the
  // same guard the page has in `currentPageRef`: a fold made while the book was
  // still on its way is the reader's own choice and outranks the saved one.
  const panelsWhenOpened = useRef({ outline: outlineOpen, chatPanel: chatPanelOpen });
  const panelsNow = useRef({ outline: outlineOpen, chatPanel: chatPanelOpen });
  panelsNow.current = { outline: outlineOpen, chatPanel: chatPanelOpen };

  // The URL is read and written through refs. Both values change identity on
  // every navigation, so depending on them would re-run these effects on each
  // page turn and let them undo one another.
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

  // Effects run in declaration order within one commit, so the write below
  // still sees the page from before the book was opened. Writing that would
  // send the reader to page 1 and straight back, which reads as a flicker.
  const urlIsAuthoritative = useRef(true);

  // The page the reader is on, readable without depending on it: the restore
  // below has to know whether they moved first, but must not re-run when they do.
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  // The width, read the same way: opening a book must not be redone every time
  // the window crosses the boundary between the two layouts.
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;

  // Opening a book starts from the place its URL names, not the previous book's
  useEffect(() => {
    const params = searchParamsRef.current;
    const namesPlace = urlNamesAPlace(params, linkedPassage);
    urlNamesPlace.current = namesPlace;
    urlNamesAChat.current = params.get(SELECTION_PARAM) !== null;
    urlIsAuthoritative.current = true;
    panelsWhenOpened.current = panelsNow.current;
    setPendingRestore(true);

    // Retired parameters go at once however the book was opened: they name
    // nothing this hook obeys, so there is no answer to wait for before
    // sweeping them, and a link that names no place would otherwise carry them
    // for as long as the fetch takes — or keep them if it never lands.
    const next = new URLSearchParams(params);
    for (const retired of RETIRED_PARAMS) next.delete(retired);

    // Where the URL names a place, spell it out even where it was implied, so
    // the address bar always holds a link that reopens the book as it stands.
    // Where it names none, the book's own place is the one to open at, and
    // until it arrives there is nothing to spell out here.
    if (namesPlace) {
      const page = parsePage(params.get(PAGE_PARAM)) ?? FIRST_PAGE;
      setCurrentPage(page);
      setPendingSelectionId(params.get(SELECTION_PARAM));
      next.set(PAGE_PARAM, String(page));
    }

    if (next.toString() !== params.toString()) {
      setSearchParamsRef.current(next, { replace: true });
    }
  }, [pdfId, linkedPassage, setCurrentPage]);

  // Reader -> URL, replacing so page turns do not pile up in the history. Every
  // parameter is written together: one commit, one navigation, nothing dropped.
  useEffect(() => {
    // A book still waiting on its saved place has no place to write yet, and
    // spelling out page 1 in the meantime would put a page nobody asked for in
    // the address bar for the restore to argue with.
    if (pendingRestore && !urlNamesPlace.current) return;

    if (urlIsAuthoritative.current) {
      urlIsAuthoritative.current = false;
      return;
    }

    const params = searchParamsRef.current;
    const next = new URLSearchParams(params);
    next.set(PAGE_PARAM, String(currentPage));
    for (const retired of RETIRED_PARAMS) next.delete(retired);
    // While the chat the URL named is still waiting for its book, the URL is the
    // only place it exists: syncing from the empty atom — which a page turn taken
    // in the meantime would do — would throw away what is being restored.
    if (pendingSelectionId === null) {
      if (activeSelectionId === null) next.delete(SELECTION_PARAM);
      else next.set(SELECTION_PARAM, activeSelectionId);
    }
    if (next.toString() === params.toString()) return;
    setSearchParamsRef.current(next, { replace: true });
  }, [currentPage, activeSelectionId, pendingSelectionId, pendingRestore]);

  // The place the book was left at, taken up once it can say which highlight the
  // saved chat is and how far the book goes.
  //
  // The two panels are taken however the book was opened — they are nowhere in
  // the URL — while the page and the chat are only taken where the URL named
  // neither. There the page, the chat and the panels were saved as one place, so
  // opening the chat without the page it was open on would land the reader
  // elsewhere; where the URL does name a page it stays the authority.
  useEffect(() => {
    if (!pendingRestore || book === undefined) return;

    const place = book.readingState;
    // A reader who turned a page before the book landed has chosen a place of
    // their own, and it outranks the one they left on another device.
    if (place !== null && !urlNamesPlace.current && currentPageRef.current === FIRST_PAGE) {
      // A book re-extracted shorter can no longer hold the page it was left on
      setCurrentPage(Math.min(place.page, book.pageCount));

      const highlight = book.selections.find((selection) => selection.id === place.selectionId);
      if (highlight !== undefined) {
        openChat({
          id: highlight.id,
          selectedText: highlight.selectedText,
          pageNumber: highlight.pageNumber,
        });
      }
    }

    // The book's own conversation, taken out of the book however it was opened.
    // The URL cannot name it — `?selection=` is the only conversation a link
    // carries — so where the reader followed a link to a highlight, that is the
    // one they asked for and this stays out of its way. Nothing here waits on
    // the reader having moved first, unlike the panels: the entry to this
    // conversation is inside the panel, so there is no way to open it before
    // the book arrives.
    if (place?.bookChat === true && !urlNamesAChat.current) openBookChat();

    // The panels are settled here whatever the book says, since they start away
    // and this is what puts them up: what the book was left with, or open where
    // it says nothing — `null`, and a book nobody has read at all, both mean the
    // reader has never folded either away. Only on a wide screen, where they sit
    // beside the page rather than over it, and only where the reader has not
    // already moved one themselves while the book was on its way.
    if (!isNarrowRef.current) {
      const opened = panelsWhenOpened.current;
      const now = panelsNow.current;
      if (now.outline === opened.outline) setOutlineOpen(place?.outlineOpen ?? true);
      if (now.chatPanel === opened.chatPanel) setChatPanelOpen(place?.chatPanelOpen ?? true);
    }

    // Where the URL had no say over this book, the write above owes it a turn
    // rather than skipping one.
    if (!urlNamesPlace.current) urlIsAuthoritative.current = false;
    setPendingRestore(false);
  }, [
    pendingRestore,
    book,
    openChat,
    openBookChat,
    setCurrentPage,
    setOutlineOpen,
    setChatPanelOpen,
  ]);

  // The chat named by the URL, reopened as soon as the book can say which
  // highlight that is
  useEffect(() => {
    if (pendingSelectionId === null || book === undefined) return;

    const highlight = book.selections.find((selection) => selection.id === pendingSelectionId);
    if (highlight !== undefined) {
      openChat({
        id: highlight.id,
        selectedText: highlight.selectedText,
        pageNumber: highlight.pageNumber,
      });
    }

    // Cleared either way: a highlight that is no longer in the book leaves the
    // list showing, and the write above takes the id back out of the URL.
    setPendingSelectionId(null);
  }, [book, pendingSelectionId, openChat]);

  // Where a passage sits in a book cannot change while the book is open, so
  // this is asked once per link and never revalidated.
  const { data: linkedPage, error: locateError } = useSWRImmutable(
    pdfId && linkedPassage ? [pdfId, "locate", linkedPassage] : null,
    () => locatePassage(pdfId!, linkedPassage!),
  );

  useEffect(() => {
    if (linkedPage?.found) setCurrentPage(linkedPage.pageNumber);
  }, [linkedPage, setCurrentPage]);

  // `undefined` is "still asking" and must not raise this; anything else is the
  // server's answer, or the lookup itself never getting one.
  const passageMiss = missOf(linkedPassage, linkedPage, locateError);

  return { passageMiss, locationReady: !pendingRestore };
}
