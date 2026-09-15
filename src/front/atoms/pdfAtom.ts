import { atom } from "jotai";

export const currentPageAtom = atom<number>(1);

/** Rendered page size, plus the page's intrinsic width at scale 1. */
export interface PageViewport {
  width: number;
  height: number;
  baseWidth: number;
}

/**
 * What each drawn page came out at, keyed by its page number.
 *
 * Keyed rather than a single size because two pages can be up at once, and the
 * overlays on each are laid over the page they belong to: one shared value
 * would be whichever of the two finished drawing last.
 */
export const pageViewportsAtom = atom<Record<number, PageViewport>>({});

/** What a page is taken to measure until it has been drawn and reported. */
export const UNDRAWN_PAGE: PageViewport = { width: 800, height: 1000, baseWidth: 800 };

/**
 * Shared by the toolbar toggle and the keyboard shortcut.
 *
 * Away until the book says otherwise, which `useReadingLocation` does as soon as
 * it arrives — from what the book was left with, or open where a wide screen has
 * room and the book says nothing. Starting open instead would put the outline up
 * for as long as the fetch takes and then take it away in front of the reader,
 * undoing the fold they had made last time.
 */
export const outlineOpenAtom = atom<boolean>(false);

/** The passage a citation quoted, to be marked on the page it was found on. */
export interface CitedPassage {
  pageNumber: number;
  text: string;
}

/**
 * The citation the reader last followed, or null once they have moved on.
 *
 * Written by the link in the answer and cleared by the viewer when the reader
 * leaves the page it points at, so the mark stays put while the passage is
 * being read instead of fading on a timer.
 */
export const citedPassageAtom = atom<CitedPassage | null>(null);
