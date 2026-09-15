import useSWR from "swr";
import { fetcher } from "../lib/fetcher";
import { chapterListSchema, type BookChapter } from "../../shared/schemas/book";

/** Reads the parts of a book a question can be aimed at. */
export type LoadChapters = (pdfId: string) => Promise<{ chapters: BookChapter[] }>;

/** Where a book's chapters are read from, and the key they are cached under. */
const CHAPTERS_PATH = "/api/pdf/";
const CHAPTERS_SUFFIX = "/chapters";

export const chaptersKey = (pdfId: string) => `${CHAPTERS_PATH}${pdfId}${CHAPTERS_SUFFIX}`;

/** The inverse of `chaptersKey`, so the fetcher reads the id off its key. */
const chaptersIdFromKey = (key: string) =>
  key.slice(CHAPTERS_PATH.length, key.length - CHAPTERS_SUFFIX.length);

export const fetchChapters: LoadChapters = (pdfId) =>
  fetcher(chaptersKey(pdfId), chapterListSchema);

/**
 * The chapters of the book, each with the pages it covers.
 *
 * Worked out by the server from the outline it stores rather than by the reader
 * from the document in front of them: the same outline is what an excerpt is
 * cut by, so what a reader picks and what the model is shown cannot disagree.
 * A book whose PDF ships no outline has none, and the whole of it is the only
 * thing left to ask about.
 */
export function useChapters(pdfId: string | undefined, loadChapters: LoadChapters = fetchChapters) {
  return useSWR(pdfId ? chaptersKey(pdfId) : null, (key: string) =>
    loadChapters(chaptersIdFromKey(key)),
  );
}
