import { useState, useCallback, useMemo } from "react";
import { Provider, useAtom, useSetAtom } from "jotai";
import { Link, useParams } from "react-router";
import { currentPageAtom } from "../atoms/pdfAtom";
import {
  activeSelectionAtom,
  chatMessagesAtom,
  chatErrorAtom,
  abortChatStreamAtom,
  type ActiveSelection,
} from "../atoms/chatAtom";
import { PdfViewer } from "../components/PdfViewer/PdfViewer";
import { ChatArea } from "../components/ChatArea/ChatArea";
import { SettingsMenu } from "../components/SettingsMenu";
import { useBook } from "../hooks/useBook";
import { useReadingLocation } from "../hooks/useReadingLocation";
import { passageFromNavigation } from "../lib/textFragment";
import { fetcher, resultFetcher } from "../lib/fetcher";
import { locatedPageSchema } from "../../shared/schemas/book";
import { chatHistorySchema } from "../../shared/schemas/chat";

/** Asks the server which page a passage from a `#:~:text=` link is on. */
async function locatePassage(pdfId: string, passage: string): Promise<number | null> {
  const { pageNumber } = await fetcher(
    `/api/pdf/${pdfId}/locate?text=${encodeURIComponent(passage)}`,
    locatedPageSchema,
  );
  return pageNumber;
}

/**
 * The reader, with a store of its own per book.
 *
 * Everything it holds — the open chat, the passage being asked about, the page
 * being read — belongs to one book and means nothing under the next one. Giving
 * the store the book's id as its key throws all of it away in a single step
 * when another book is opened, instead of resetting each piece by hand and
 * rendering once with whatever was missed. The book itself survives the swap:
 * it lives in the SWR cache, which is outside the store.
 */
export function AppPage() {
  const { pdfId } = useParams();

  return (
    <Provider key={pdfId}>
      <BookReader pdfId={pdfId} />
    </Provider>
  );
}

function BookReader({ pdfId }: { pdfId: string | undefined }) {
  const { data: book, error } = useBook(pdfId);
  const [, setActiveSelection] = useAtom(activeSelectionAtom);
  const [, setChatMessages] = useAtom(chatMessagesAtom);
  const [, setChatError] = useAtom(chatErrorAtom);
  const [, setCurrentPage] = useAtom(currentPageAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);
  const [leftWidth, setLeftWidth] = useState(60);

  // Only the URL the document was loaded with can carry a text fragment
  const linkedPassage = useMemo(
    () => passageFromNavigation(performance.getEntriesByType("navigation")),
    [],
  );
  useReadingLocation(pdfId, locatePassage, linkedPassage);

  // Load chat history when selection changes
  const handleSelectionClick = useCallback(
    async (selection: ActiveSelection) => {
      // An answer still streaming belongs to the chat being left behind
      abortChatStream();
      setActiveSelection(selection);
      // The highlight can be picked from the list while another page is shown
      setCurrentPage(selection.pageNumber);
      // Otherwise the conversation left behind shows under the new passage
      // until its own history arrives
      setChatMessages([]);
      // Whatever failed in the chat being left is not about this one
      setChatError(null);
      if (!pdfId) return;

      const history = await resultFetcher(
        `/api/pdf/${pdfId}/selections/${selection.id}/chats`,
        chatHistorySchema,
      );

      // An empty conversation and one that could not be read used to look the
      // same, so a failure here read as "you never asked anything about this".
      history.match(
        (data) => setChatMessages(data.messages),
        (failure) => setChatError(`チャット履歴を読み込めませんでした: ${failure.message}`),
      );
    },
    [abortChatStream, pdfId, setActiveSelection, setChatError, setChatMessages, setCurrentPage],
  );

  return (
    <div className="h-screen flex flex-col bg-white">
      <header className="flex items-center h-12 px-4 border-b border-gray-200 bg-gray-50 shrink-0">
        <Link to="/" className="text-lg font-bold text-gray-800 hover:text-blue-600">
          chatbook
        </Link>
        <Link to="/" className="ml-4 text-sm text-blue-600 hover:underline">
          ← 本棚
        </Link>
        {book && (
          <span className="ml-3 text-sm text-gray-500 truncate max-w-xs">{book.fileName}</span>
        )}
        <div className="ml-auto">
          <SettingsMenu />
        </div>
      </header>
      <main className="flex-1 min-h-0 flex">
        {/* Left panel: PDF Viewer */}
        <div style={{ width: `${leftWidth}%` }} className="h-full min-w-0">
          <PdfViewer
            book={book}
            bookError={error as Error | undefined}
            onSelectionClick={handleSelectionClick}
          />
        </div>

        {/* Resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="PDFとチャットの幅を変更"
          className="w-1.5 bg-gray-200 hover:bg-blue-400 cursor-col-resize shrink-0 transition-colors active:bg-blue-500"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = leftWidth;

            const handleMouseMove = (moveEvent: MouseEvent) => {
              const delta = ((moveEvent.clientX - startX) / window.innerWidth) * 100;
              const newWidth = Math.min(80, Math.max(20, startWidth + delta));
              setLeftWidth(newWidth);
            };

            const handleMouseUp = () => {
              document.removeEventListener("mousemove", handleMouseMove);
              document.removeEventListener("mouseup", handleMouseUp);
            };

            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
          }}
        />

        {/* Right panel: Chat Area */}
        <div style={{ width: `${100 - leftWidth}%` }} className="h-full min-w-0">
          <ChatArea
            book={book}
            bookError={error as Error | undefined}
            onSelectionClick={handleSelectionClick}
          />
        </div>
      </main>
    </div>
  );
}
