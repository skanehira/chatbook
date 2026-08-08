import useSWR from "swr";
import { fetcher } from "../lib/fetcher";
import { bookDetailSchema, type BookDetail } from "../../shared/schemas/book";

/** Reads one book and the highlights made in it. */
export type LoadBook = (pdfId: string) => Promise<BookDetail>;

/**
 * Cache key of one book.
 *
 * The reader, the viewer and the chat panel all address this key, so the book
 * is read once however many of them are on screen, a highlight added to it
 * shows in all of them at once, and an upload can fill it in advance so that
 * opening the book it just wrote does not wait for a round trip.
 */
const BOOK_PATH = "/api/pdf/";

export const bookKey = (pdfId: string) => `${BOOK_PATH}${pdfId}`;

/** The inverse of `bookKey`, so the fetcher reads the id off the key it is given. */
const bookIdFromKey = (key: string) => key.slice(BOOK_PATH.length);

export const fetchBook: LoadBook = (pdfId) => fetcher(bookKey(pdfId), bookDetailSchema);

/** The book with the given id, or nothing at all while no book is open. */
export function useBook(pdfId: string | undefined, loadBook: LoadBook = fetchBook) {
  // The id comes back out of the key rather than off the closure, so what is
  // fetched cannot drift from what the result is filed under.
  return useSWR(pdfId ? bookKey(pdfId) : null, (key: string) => loadBook(bookIdFromKey(key)));
}
