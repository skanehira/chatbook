import { atom } from "jotai";

export const currentPageAtom = atom<number>(1);
/** Rendered page size, plus the page's intrinsic width at scale 1. */
export const pageViewportAtom = atom<{ width: number; height: number; baseWidth: number }>({
  width: 800,
  height: 1000,
  baseWidth: 800,
});

/** Shared by the toolbar toggle and the keyboard shortcut. */
export const outlineOpenAtom = atom<boolean>(true);
