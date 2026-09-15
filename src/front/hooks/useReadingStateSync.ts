// oxlint-disable-next-line no-restricted-imports -- 読書位置をサーバ (React の外の状態) へ同期し、離脱時に書き残しを送るために必要
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { ResultAsync } from "neverthrow";
import { currentPageAtom, outlineOpenAtom } from "../atoms/pdfAtom";
import { activeSelectionAtom, bookChatOpenAtom, chatPanelOpenAtom } from "../atoms/chatAtom";
import { resultFetcher, type ApiError } from "../lib/fetcher";
import { useIsNarrow } from "./useIsNarrow";
import { readingStateSavedSchema, type SaveReadingStateRequest } from "../../shared/schemas/book";

/**
 * How long a turned page waits before it is saved.
 *
 * Long enough that flipping through a chapter is one write rather than thirty,
 * short enough that putting the book down and picking it up elsewhere lands on
 * the page the reader stopped at.
 */
export const SAVE_DEBOUNCE_MS = 1000;

/**
 * Sends the reader's place to the server. `keepalive` is for the ones sent as
 * the page is going away, which the browser would otherwise cancel.
 */
export type SaveReadingState = (
  pdfId: string,
  place: SaveReadingStateRequest,
  options?: { keepalive?: boolean },
) => ResultAsync<{ saved: true }, ApiError>;

const putReadingState: SaveReadingState = (pdfId, place, options) =>
  resultFetcher(`/api/pdf/${pdfId}/reading-state`, readingStateSavedSchema, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(place),
    keepalive: options?.keepalive,
  });

function samePlace(one: SaveReadingStateRequest, other: SaveReadingStateRequest): boolean {
  return (
    one.page === other.page &&
    one.selectionId === other.selectionId &&
    one.bookChat === other.bookChat &&
    one.outlineOpen === other.outlineOpen &&
    one.chatPanelOpen === other.chatPanelOpen
  );
}

/**
 * Keep the reader's place on the server, so the book can be picked up on
 * another device where it was put down.
 *
 * This is a sink, not a fetch: the page is written by the stepper, the
 * keyboard, a tap on the page's edge and a citation followed out of an answer,
 * so watching the state they all land in is the only place that sees every
 * turn. Hanging the write off each of them instead would quietly miss the next
 * one added.
 *
 * Nothing is written until `locationReady` — the place may still be arriving
 * from the server, and page 1 written over it would be the reader's place lost
 * rather than kept. The first thing seen once it is ready is the place that was
 * just restored, which is taken as already saved rather than handed back.
 *
 * That is true wherever the place came from: a book opened at a place the URL
 * named — a reload, a shared link, a quoted passage — is not handed back either.
 * What reaches the server is the first place the reader moves to afterwards,
 * which carries the whole place with it.
 *
 * A narrow screen leaves both panels out of what it sends: there the outline is
 * a drawer that shuts itself on every jump and the chat a sheet, and saving
 * those would fold away what a wide screen deliberately opened. The server
 * keeps whatever it had.
 */
export function useReadingStateSync(
  pdfId: string | undefined,
  locationReady: boolean,
  save: SaveReadingState = putReadingState,
  debounceMs: number = SAVE_DEBOUNCE_MS,
): { saveError: string | null } {
  const currentPage = useAtomValue(currentPageAtom);
  const selectionId = useAtomValue(activeSelectionAtom)?.id ?? null;
  const bookChat = useAtomValue(bookChatOpenAtom);
  const outlineOpen = useAtomValue(outlineOpenAtom);
  const chatPanelOpen = useAtomValue(chatPanelOpenAtom);
  const isNarrow = useIsNarrow();
  const [saveError, setSaveError] = useState<string | null>(null);

  // `bookChat` rides with the page and the selection on both layouts — it is
  // which conversation was open, not how the panels sat — while the two panels
  // are left out by a narrow screen, which has a drawer and a sheet instead.
  const place: SaveReadingStateRequest = useMemo(
    () =>
      isNarrow
        ? { page: currentPage, selectionId, bookChat }
        : { page: currentPage, selectionId, bookChat, outlineOpen, chatPanelOpen },
    [currentPage, selectionId, bookChat, outlineOpen, chatPanelOpen, isNarrow],
  );

  /** The place the server holds, as far as this reader knows. */
  const lastSaved = useRef<SaveReadingStateRequest | null>(null);

  // Read by the departure below, which fires long after the render that would
  // have handed it these.
  const placeRef = useRef(place);
  placeRef.current = place;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!locationReady || pdfId === undefined) return;

    // The first place seen after the restore is what the server already holds
    if (lastSaved.current === null) {
      lastSaved.current = place;
      return;
    }
    if (samePlace(lastSaved.current, place)) return;

    const timer = setTimeout(() => {
      void save(pdfId, place)
        .andTee(() => {
          lastSaved.current = place;
          setSaveError(null);
        })
        // Left standing until something else moves, which is also what tries
        // again: a place that failed to save is one the reader can still see is
        // not kept.
        .orTee((failure) => setSaveError(failure.message));
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [locationReady, pdfId, place, save, debounceMs]);

  // Leaving takes the turn still being waited on with it — back to the shelf,
  // which unmounts the reader, or the tab being closed, which does not.
  useEffect(() => {
    if (!locationReady || pdfId === undefined) return;

    const flush = () => {
      const leaving = placeRef.current;
      if (lastSaved.current === null || samePlace(lastSaved.current, leaving)) return;

      lastSaved.current = leaving;
      // Swallowed on purpose: there is no longer a reader to tell, and the
      // request has to outlive the page it was sent from to arrive at all.
      void saveRef.current(pdfId, leaving, { keepalive: true });
    };

    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [locationReady, pdfId]);

  return { saveError };
}
