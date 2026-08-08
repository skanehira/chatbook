// oxlint-disable-next-line no-restricted-imports -- URL の pdfId から本を復元するために必要
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Link, useParams } from "react-router";
import { pdfDocAtom, pdfStatusAtom, pdfErrorAtom, currentPageAtom } from "../atoms/pdfAtom";
import {
  activeSelectionAtom,
  chatMessagesAtom,
  abortChatStreamAtom,
  type ActiveSelection,
} from "../atoms/chatAtom";
import { PdfViewer } from "../components/PdfViewer/PdfViewer";
import { ChatArea } from "../components/ChatArea/ChatArea";
import { SettingsMenu } from "../components/SettingsMenu";
import { useReadingLocation } from "../hooks/useReadingLocation";
import { passageFromNavigation } from "../lib/textFragment";
import { fetcher } from "../lib/fetcher";
import { bookDetailSchema, locatedPageSchema } from "../../shared/schemas/book";
import { chatHistorySchema } from "../../shared/schemas/chat";

/** Asks the server which page a passage from a `#:~:text=` link is on. */
async function locatePassage(pdfId: string, passage: string): Promise<number | null> {
  const { pageNumber } = await fetcher(
    `/api/pdf/${pdfId}/locate?text=${encodeURIComponent(passage)}`,
    locatedPageSchema,
  );
  return pageNumber;
}

export function AppPage() {
  const { pdfId } = useParams();
  const [pdfDoc, setPdfDoc] = useAtom(pdfDocAtom);
  const [, setPdfStatus] = useAtom(pdfStatusAtom);
  const [, setPdfError] = useAtom(pdfErrorAtom);
  const [, setActiveSelection] = useAtom(activeSelectionAtom);
  const [, setChatMessages] = useAtom(chatMessagesAtom);
  const [, setCurrentPage] = useAtom(currentPageAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);
  const [leftWidth, setLeftWidth] = useState(60);

  // Only the URL the document was loaded with can carry a text fragment
  const linkedPassage = useMemo(
    () => passageFromNavigation(performance.getEntriesByType("navigation")),
    [],
  );
  useReadingLocation(pdfId, locatePassage, linkedPassage);

  // Restore the book from the URL. Without this a reload or a direct link
  // would land on an empty viewer, since the atom is only filled by an upload.
  useEffect(() => {
    if (!pdfId || pdfDoc?.id === pdfId) return;

    let cancelled = false;
    setActiveSelection(null);
    setChatMessages([]);
    setPdfStatus("loading");
    setPdfError(null);

    fetcher(`/api/pdf/${pdfId}`, bookDetailSchema)
      .then((book) => {
        if (cancelled) return;
        setPdfDoc({ id: book.id, fileName: book.fileName, pageCount: book.pageCount });
        setPdfStatus("ready");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setPdfError(err.message);
        setPdfStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [
    pdfId,
    pdfDoc?.id,
    setPdfDoc,
    setPdfStatus,
    setPdfError,
    setActiveSelection,
    setChatMessages,
  ]);

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
      if (!pdfDoc) return;

      try {
        const data = await fetcher(
          `/api/pdf/${pdfDoc.id}/selections/${selection.id}/chats`,
          chatHistorySchema,
        );

        setChatMessages(data.messages);
      } catch {
        setChatMessages([]);
      }
    },
    [abortChatStream, pdfDoc, setActiveSelection, setChatMessages, setCurrentPage],
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
        {pdfDoc && (
          <span className="ml-3 text-sm text-gray-500 truncate max-w-xs">{pdfDoc.fileName}</span>
        )}
        <div className="ml-auto">
          <SettingsMenu />
        </div>
      </header>
      <main className="flex-1 min-h-0 flex">
        {/* Left panel: PDF Viewer */}
        <div style={{ width: `${leftWidth}%` }} className="h-full min-w-0">
          <PdfViewer onSelectionClick={handleSelectionClick} />
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
          <ChatArea onSelectionClick={handleSelectionClick} />
        </div>
      </main>
    </div>
  );
}
