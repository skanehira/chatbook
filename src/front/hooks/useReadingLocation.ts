// oxlint-disable-next-line no-restricted-imports -- 読書位置を URL (外部状態) へ同期し、SWR が解決したページを共有ストアへ反映するために必要
import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { useSearchParams } from "react-router";
import useSWRImmutable from "swr/immutable";
import { currentPageAtom } from "../atoms/pdfAtom";

/** Resolves a quoted passage to the page it appears on, or null if absent. */
export type LocatePassage = (pdfId: string, passage: string) => Promise<number | null>;

const PAGE_PARAM = "page";

function parsePage(value: string | null): number | null {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

/**
 * Keep the page being read and the URL in sync, so a reload or a shared link
 * resumes on the same page.
 *
 * The page being read is the single source of truth: the URL is read once per
 * book and written on every page turn. Watching the URL as well would make the
 * two effects feed each other, and the reader would bounce between pages.
 *
 * A `#:~:text=` fragment — what Chrome's "Copy link to highlight" writes — wins
 * over `?page=`, since it names the passage the reader actually wants.
 */
export function useReadingLocation(
  pdfId: string | undefined,
  locatePassage: LocatePassage,
  linkedPassage: string | null,
): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentPage, setCurrentPage] = useAtom(currentPageAtom);

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

  // Opening a book starts from the page its URL names, not the previous book's
  useEffect(() => {
    const params = searchParamsRef.current;
    const page = parsePage(params.get(PAGE_PARAM)) ?? 1;

    urlIsAuthoritative.current = true;
    setCurrentPage(page);

    // Spell the page out even when it was implied, so the address bar always
    // holds a link that reopens the book where it is now
    if (params.get(PAGE_PARAM) !== String(page)) {
      const next = new URLSearchParams(params);
      next.set(PAGE_PARAM, String(page));
      setSearchParamsRef.current(next, { replace: true });
    }
  }, [pdfId, setCurrentPage]);

  // Reader -> URL, replacing so page turns do not pile up in the history
  useEffect(() => {
    if (urlIsAuthoritative.current) {
      urlIsAuthoritative.current = false;
      return;
    }

    const next = new URLSearchParams(searchParamsRef.current);
    if (next.get(PAGE_PARAM) === String(currentPage)) return;
    next.set(PAGE_PARAM, String(currentPage));
    setSearchParamsRef.current(next, { replace: true });
  }, [currentPage]);

  // Where a passage sits in a book cannot change while the book is open, so
  // this is asked once per link and never revalidated.
  const { data: linkedPage } = useSWRImmutable(
    pdfId && linkedPassage ? [pdfId, "locate", linkedPassage] : null,
    () => locatePassage(pdfId!, linkedPassage!),
  );

  useEffect(() => {
    if (linkedPage) setCurrentPage(linkedPage);
  }, [linkedPage, setCurrentPage]);
}
