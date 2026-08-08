import { useState, useCallback } from "react";
import { useNavigate } from "react-router";
import useSWR from "swr";
import type { ResultAsync } from "neverthrow";
import { FileSelector } from "../components/PdfViewer/FileSelector";
import { fetcher, resultFetcher, type ApiError } from "../lib/fetcher";
import type { ExtractedPdfData } from "../lib/pdfLoader";
import { bookDeletedSchema, bookListSchema, type BookSummary } from "../../shared/schemas/book";

/** Cache key of the shelf, and the endpoint it is read from. */
const SHELF_KEY = "/api/pdfs";

/** Read by SWR, so a refusal belongs in its `error` state: this one throws. */
const fetchBooks = () => fetcher(SHELF_KEY, bookListSchema).then((data) => data.books);

/** Removes a book. A write, so its failure comes back in the value. */
export type DeleteBook = (id: string) => ResultAsync<unknown, ApiError>;

const requestBookDeletion: DeleteBook = (id) =>
  resultFetcher(`/api/pdf/${id}`, bookDeletedSchema, { method: "DELETE" });

interface ShelfPageProps {
  loadBooks?: () => Promise<BookSummary[]>;
  deleteBook?: DeleteBook;
  /** Passed straight to the file picker; injectable so tests can fail a read. */
  extract?: (file: File) => Promise<ExtractedPdfData>;
}

function bookTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

function BookCard({
  book,
  onOpen,
  onDelete,
}: {
  book: BookSummary;
  onOpen: (id: string) => void;
  onDelete: (book: BookSummary) => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = book.hasThumbnail && !coverFailed;
  const title = bookTitle(book.fileName);

  return (
    <div className="relative group/card">
      <button
        type="button"
        aria-label={`${title} を開く`}
        onClick={() => onOpen(book.id)}
        className="group flex w-full flex-col text-left cursor-pointer focus:outline-none"
      >
        <div className="relative aspect-3/4 w-full overflow-hidden rounded-r-md rounded-l-sm border-l-4 border-gray-300 bg-gray-100 shadow-md transition-all group-hover:-translate-y-1 group-hover:shadow-xl group-focus-visible:ring-2 group-focus-visible:ring-blue-500">
          {showCover ? (
            <img
              src={`/api/pdf/${book.id}/thumbnail`}
              alt={`${title} の表紙`}
              loading="lazy"
              onError={() => setCoverFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-slate-600 to-slate-800 p-3">
              <span className="line-clamp-5 text-center text-xs font-medium text-white/90">
                {title}
              </span>
            </div>
          )}
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium text-gray-800">{title}</p>
        <p className="text-xs text-gray-500">{book.pageCount} ページ</p>
      </button>

      <button
        type="button"
        aria-label={`${title} を削除`}
        onClick={() => onDelete(book)}
        className="absolute right-1.5 top-1.5 rounded-full bg-black/55 px-2 py-0.5 text-sm leading-normal text-white opacity-0 transition-opacity cursor-pointer hover:bg-red-600 focus-visible:opacity-100 group-hover/card:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

function DeleteConfirmDialog({
  book,
  onConfirm,
  onCancel,
}: {
  book: BookSummary;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    // Escape is handled here rather than on document, so the listener lives and
    // dies with the dialog itself.
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="本の削除"
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
      >
        <p className="text-sm text-gray-800">
          「{bookTitle(book.fileName)}」を削除しますか？ハイライトとチャット履歴も削除されます。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 cursor-pointer hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white cursor-pointer hover:bg-red-700"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShelfPage({
  loadBooks = fetchBooks,
  deleteBook = requestBookDeletion,
  extract,
}: ShelfPageProps = {}) {
  const navigate = useNavigate();
  const { data: books, error: loadError, mutate } = useSWR(SHELF_KEY, loadBooks);
  // What the reader's last action did wrong: adding a book, or removing one.
  // Both are worded by whoever detected them and shown in the same place.
  const [actionError, setActionError] = useState<string | null>(null);
  const [bookPendingDeletion, setBookPendingDeletion] = useState<BookSummary | null>(null);

  const error =
    actionError ??
    (loadError ? `本棚の読み込みに失敗しました: ${(loadError as Error).message}` : null);

  const openBook = useCallback((id: string) => navigate(`/books/${id}`), [navigate]);

  const removeBook = async (book: BookSummary) => {
    setActionError(null);
    setBookPendingDeletion(null);

    const removal = await deleteBook(book.id);
    if (removal.isErr()) {
      setActionError(`削除に失敗しました: ${removal.error.message}`);
      return;
    }

    // The server has already dropped it, so re-reading the shelf would only
    // confirm what this list can work out for itself.
    await mutate((current) => current?.filter((b) => b.id !== book.id), { revalidate: false });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex h-12 items-center justify-between border-b border-gray-200 bg-white px-4">
        <h1 className="text-lg font-bold text-gray-800">chatbook</h1>
        <FileSelector
          onOpened={(id) => {
            setActionError(null);
            void openBook(id);
          }}
          onError={setActionError}
          extract={extract}
          label="PDFを追加"
        />
      </header>

      <main className="mx-auto max-w-6xl p-6">
        {error && <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</p>}

        {!books && !error && <p className="text-sm text-gray-500">読み込み中...</p>}

        {books?.length === 0 && !error && (
          <div className="py-24 text-center">
            <p className="text-lg font-medium text-gray-700">まだ本がありません</p>
            <p className="mt-1 text-sm text-gray-500">
              右上の「PDFを追加」から技術書を追加してください
            </p>
          </div>
        )}

        {books && books.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-5">
            {books.map((book) => (
              <li key={book.id}>
                <BookCard book={book} onOpen={openBook} onDelete={setBookPendingDeletion} />
              </li>
            ))}
          </ul>
        )}
      </main>

      {bookPendingDeletion && (
        <DeleteConfirmDialog
          book={bookPendingDeletion}
          onConfirm={() => removeBook(bookPendingDeletion)}
          onCancel={() => setBookPendingDeletion(null)}
        />
      )}
    </div>
  );
}
