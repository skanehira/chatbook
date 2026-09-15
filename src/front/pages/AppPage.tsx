import { useState, useCallback, useMemo, useRef } from "react";
import { Provider, useAtom, useSetAtom } from "jotai";
import { Link, useParams } from "react-router";
import { citedPassageAtom, currentPageAtom, outlineOpenAtom } from "../atoms/pdfAtom";
import {
  activeSelectionAtom,
  bookChatOpenAtom,
  chatMessagesAtom,
  chatErrorAtom,
  chatMaximizedAtom,
  chatPanelOpenAtom,
  chatSheetAtom,
  abortChatStreamAtom,
  type ActiveSelection,
} from "../atoms/chatAtom";
import { PdfViewer } from "../components/PdfViewer/PdfViewer";
import { PageToolbar } from "../components/PdfViewer/PageToolbar";
import { ChatArea } from "../components/ChatArea/ChatArea";
import { ChatSheet } from "../components/ChatArea/ChatSheet";
import { SettingsMenu } from "../components/SettingsMenu";
import { useBook } from "../hooks/useBook";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { useReadingLocation, type PassageMiss } from "../hooks/useReadingLocation";
import { useReadingStateSync } from "../hooks/useReadingStateSync";
import { passageFromNavigation } from "../lib/textFragment";
import { fetcher, resultFetcher } from "../lib/fetcher";
import { locatedPageSchema, type LocatedPage } from "../../shared/schemas/book";
import { chatHistorySchema } from "../../shared/schemas/chat";

/**
 * How wide the handle between the panes is, in pixels.
 *
 * Wide enough for a thumb, which is where 44 comes from. The handle itself and
 * the room each pane gives up for it both read this: the panes are sized in
 * percentages and have to hand back half of it each for the three to add up,
 * so a width written twice would drift and put them back over the window.
 */
const HANDLE_WIDTH = 44;

/** Asks the server which page a passage from a `#:~:text=` link is on. */
async function locatePassage(pdfId: string, passage: string): Promise<LocatedPage> {
  return fetcher(`/api/pdf/${pdfId}/locate?text=${encodeURIComponent(passage)}`, locatedPageSchema);
}

/**
 * What to tell a reader whose link named a passage the book did not open at.
 * "Not found" alone reads as a broken link; each of these is a different thing
 * to do next, and one of them means the quote may not be the book's words.
 */
const PASSAGE_MISS_MESSAGE: Record<PassageMiss, string> = {
  "not-in-book": "リンクされた箇所が本文に見つかりませんでした",
  "no-quote": "リンクに引用文が入っていません",
  "single-page-book": "この本は1ページなので移動先がありません",
  "lookup-failed": "リンクされた箇所を探せませんでした",
};

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
  const setBookChatOpen = useSetAtom(bookChatOpenAtom);
  const [, setChatMessages] = useAtom(chatMessagesAtom);
  const [, setChatError] = useAtom(chatErrorAtom);
  const [, setCurrentPage] = useAtom(currentPageAtom);
  const setCitedPassage = useSetAtom(citedPassageAtom);
  const [chatPanelOpen, setChatPanelOpen] = useAtom(chatPanelOpenAtom);
  const [chatMaximized, setChatMaximized] = useAtom(chatMaximizedAtom);
  const [outlineOpen, setOutlineOpen] = useAtom(outlineOpenAtom);
  const [chatSheet, setChatSheet] = useAtom(chatSheetAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);
  const [leftWidth, setLeftWidth] = useState(60);
  /** Where the handle was grabbed, while it is being dragged. */
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const isNarrow = useIsNarrow();

  // Only the URL the document was loaded with can carry a text fragment
  const linkedPassage = useMemo(
    () => passageFromNavigation(performance.getEntriesByType("navigation")),
    [],
  );

  /**
   * Clear the panel for a conversation about to be opened.
   *
   * An answer still streaming belongs to the conversation being left behind, a
   * thread left on screen shows under the new one until its own history
   * arrives, and whatever failed in it is not this one's failure. On one column
   * the conversation waits out of the way until it is asked for, and opening
   * one — off the page, off the list, out of a link, or from the list's own way
   * into the book — is the asking; a sheet already drawn up is left where it is.
   */
  const openConversation = useCallback(() => {
    abortChatStream();
    setChatMessages([]);
    setChatError(null);
    // The passage a citation of the previous chat pointed at is not this one's,
    // and both would otherwise be marked on the same page
    setCitedPassage(null);
    if (isNarrow) setChatSheet((sheet) => (sheet === "closed" ? "half" : sheet));
  }, [abortChatStream, isNarrow, setChatError, setChatMessages, setChatSheet, setCitedPassage]);

  /**
   * Read a conversation in, whichever of the two it is.
   *
   * An empty conversation and one that could not be read used to look the same,
   * so a failure here read as "you never asked anything about this".
   */
  const loadConversation = useCallback(
    async (url: string) => {
      const history = await resultFetcher(url, chatHistorySchema);

      history.match(
        (data) => setChatMessages(data.messages),
        (failure) => setChatError(`チャット履歴を読み込めませんでした: ${failure.message}`),
      );
    },
    [setChatError, setChatMessages],
  );

  /**
   * Put a highlight's conversation on screen, with whatever was asked before.
   *
   * Which page the reader is on is deliberately not part of this: a chat picked
   * off the list moves the page to its passage, while one restored from the URL
   * leaves the page that same URL named alone.
   */
  const openChat = useCallback(
    async (selection: ActiveSelection) => {
      openConversation();
      // One panel, two kinds of conversation: the passage's wins over the
      // book's, and opening one is leaving the other behind.
      setBookChatOpen(false);
      setActiveSelection(selection);
      if (!pdfId) return;

      await loadConversation(`/api/pdf/${pdfId}/selections/${selection.id}/chats`);
    },
    [loadConversation, openConversation, pdfId, setActiveSelection, setBookChatOpen],
  );

  /**
   * Put the book's own conversation on screen: the same panel, showing what the
   * reader asks about the work rather than about a passage of it.
   */
  const openBookChat = useCallback(async () => {
    openConversation();
    setActiveSelection(null);
    setBookChatOpen(true);
    if (!pdfId) return;

    await loadConversation(`/api/pdf/${pdfId}/chats`);
  }, [loadConversation, openConversation, pdfId, setActiveSelection, setBookChatOpen]);

  const { passageMiss, locationReady } = useReadingLocation(
    pdfId,
    locatePassage,
    linkedPassage,
    book,
    openChat,
    openBookChat,
  );
  const { saveError } = useReadingStateSync(pdfId, locationReady);

  const handleSelectionClick = useCallback(
    (selection: ActiveSelection) => {
      // The highlight can be picked from the list while another page is shown
      setCurrentPage(selection.pageNumber);
      // Nothing to wait for: reading the history in shows it, and a history that
      // could not be read says so through `chatErrorAtom`
      void openChat(selection);
    },
    [openChat, setCurrentPage],
  );

  return (
    // `dvh` rather than `vh`: mobile browsers count their collapsing toolbars
    // out of the former, so the bottom of the reader is not left under them.
    // `overflow-clip` because the sheet parks itself outside the pane it slides
    // into, and a scrollable shell would let a focused composer drag the whole
    // reader up to reach it.
    <div className="h-dvh flex flex-col bg-white overflow-clip">
      <header className="flex items-center h-12 px-4 border-b border-gray-200 bg-gray-50 shrink-0">
        {/* Two links to the shelf is one too many on a phone, and the wordmark
            is the one that says nothing the other does not. */}
        <Link
          to="/"
          className="hidden shrink-0 text-lg font-bold text-gray-800 hover:text-blue-600 md:block"
        >
          chatbook
        </Link>
        {/* Never wrapped: squeezed onto two lines it reads as two words rather
            than one way out. Whatever room is short comes out of the title. */}
        <Link
          to="/"
          className="shrink-0 whitespace-nowrap text-sm text-blue-600 hover:underline md:ml-4"
        >
          ← 本棚
        </Link>
        {book && (
          <span className="ml-3 min-w-0 flex-1 truncate text-sm text-gray-500 md:flex-none md:max-w-xs">
            {book.fileName}
          </span>
        )}
        {/* Both toggles live up here rather than in the panels they fold away,
            which would take the way back out with them — and side by side,
            since folding the outline and folding the chat are the same kind of
            thing. On one column there is no panel to fold: the toolbar at the
            bottom raises the sheet instead, within reach of a thumb. */}
        <div className="ml-auto flex items-center gap-3">
          {!isNarrow && (
            <>
              <button
                type="button"
                onClick={() => setOutlineOpen((open) => !open)}
                aria-pressed={outlineOpen}
                className="px-3 py-1 bg-white border rounded cursor-pointer text-sm text-gray-600 hover:bg-gray-50"
              >
                {outlineOpen ? "目次を隠す" : "目次を表示"}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Folding the chat away is the reader asking for the page,
                  // which is the opposite of what maximizing asked for. Left
                  // standing it would come back on 「チャットを表示」 and hide
                  // the page they had just asked to see.
                  setChatPanelOpen((open) => !open);
                  setChatMaximized(false);
                }}
                aria-pressed={chatPanelOpen}
                className="px-3 py-1 bg-white border rounded cursor-pointer text-sm text-gray-600 hover:bg-gray-50"
              >
                {chatPanelOpen ? "チャットを隠す" : "チャットを表示"}
              </button>
              {/* Next to the toggle that folds the chat, since giving it the
                  window and taking it away are the same kind of thing — and up
                  here rather than in the panel, which the page would otherwise
                  be trapped behind. Nothing to maximize while the chat is
                  folded away. */}
              {chatPanelOpen && (
                <button
                  type="button"
                  onClick={() => setChatMaximized((maximized) => !maximized)}
                  aria-pressed={chatMaximized}
                  className="px-3 py-1 bg-white border rounded cursor-pointer text-sm text-gray-600 hover:bg-gray-50"
                >
                  {chatMaximized ? "最大化を解除" : "チャットを最大化"}
                </button>
              )}
            </>
          )}
          <SettingsMenu />
        </div>
      </header>

      {/* A link that named a passage but did not land on it opens the book at
          page 1, which is indistinguishable from an ordinary link. */}
      {passageMiss !== null && (
        <p role="status" className="shrink-0 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {PASSAGE_MISS_MESSAGE[passageMiss]}: {linkedPassage}
        </p>
      )}

      {/* Reading carries on regardless, but silently forgetting where the
          reader is would send the next device they pick up somewhere they
          never were, with nothing on screen to explain it. */}
      {saveError !== null && (
        <p role="status" className="shrink-0 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          読書位置を保存できませんでした: {saveError}
        </p>
      )}

      {/* `relative` so the sheet can be bounded by the page's pane, which ends
          above the toolbar rather than at the bottom of the window. */}
      <main className="relative flex-1 min-h-0 flex">
        {/* Left panel: PDF Viewer. It takes the whole width the folded panel
            leaves behind, and gets its share back on the way out. */}
        <div
          style={
            isNarrow
              ? undefined
              : {
                  // The handle sits between the two panes and takes room of its
                  // own, so each pane gives up half of it. Without this the
                  // three of them add up to more than the window and flex
                  // shrinks the panes by an amount nothing has accounted for.
                  width: chatPanelOpen ? `calc(${leftWidth}% - ${HANDLE_WIDTH / 2}px)` : "100%",
                  // Hidden, and left at the width it had. Taking the pane down
                  // — or shrinking it to nothing — would take the viewer's
                  // pages, its selection and the keyboard shortcuts it
                  // subscribes with it, and hand back a redrawn page on the way
                  // out; keeping its size means the viewer's ResizeObserver
                  // never hears about this at all. What the reader gives up is
                  // that ←/→ still turn pages they cannot see.
                  visibility: chatMaximized ? "hidden" : undefined,
                }
          }
          className={`h-full min-w-0 ${isNarrow ? "w-full" : ""}`}
        >
          <PdfViewer
            pdfId={pdfId}
            book={book}
            bookError={error as Error | undefined}
            onSelectionClick={handleSelectionClick}
          />
        </div>

        {isNarrow && (
          <ChatSheet state={chatSheet} onChange={setChatSheet}>
            <ChatArea
              book={book}
              bookError={error as Error | undefined}
              onSelectionClick={handleSelectionClick}
              onOpenBookChat={openBookChat}
            />
          </ChatSheet>
        )}

        {/* The handle and the panel it sizes come and go together: a handle for
            a panel that is not there has nothing to drag. */}
        {!isNarrow && chatPanelOpen && (
          <>
            {/* The handle a mouse, a finger and a pen all drag.
                `setPointerCapture` keeps the moves coming to this element even
                once the pointer has left it, which is what the listeners on
                `document` used to be for — and unlike them it works for touch.
                `touch-action: none` is what stops a finger's drag being taken
                as a scroll before the first move ever arrives.
                Wide enough for a thumb, with the line inside it kept thin. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="PDFとチャットの幅を変更"
              style={{ width: HANDLE_WIDTH, visibility: chatMaximized ? "hidden" : undefined }}
              className="group flex shrink-0 cursor-col-resize touch-none items-stretch"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                dragRef.current = { startX: e.clientX, startWidth: leftWidth };
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current;
                if (!drag) return;
                const delta = ((e.clientX - drag.startX) / window.innerWidth) * 100;
                setLeftWidth(Math.min(80, Math.max(20, drag.startWidth + delta)));
              }}
              onPointerUp={() => {
                dragRef.current = null;
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
            >
              {/* The room a thumb needs is wider than the line the eye reads as
                  the join, so each half of it carries the ground of the pane it
                  is next to (`PdfViewer`'s grey and `ChatArea`'s white) and the
                  line lands where the two meet. Left bare the whole width shows
                  the shell underneath, which is white, and 44px of white
                  against the chat reads as the chat panel starting a thumb's
                  width early. */}
              <span aria-hidden="true" className="flex-1 bg-gray-100" />
              {/* A step darker than the ground on its left: with white on only
                  one side now, the old shade half disappears, and a handle
                  nobody can see is one nobody drags. */}
              <span
                aria-hidden="true"
                className="w-1.5 bg-gray-300 transition-colors group-hover:bg-blue-400 group-active:bg-blue-500"
              />
              <span aria-hidden="true" className="flex-1 bg-white" />
            </div>

            {/* Right panel: Chat Area */}
            {/* The same element either way: split in two, React would build
                a second `ChatArea` and the conversation on screen, the search
                that narrowed the list and anything half-typed would go with the
                first one. Maximized it is laid over the pane it grew out of,
                which is why the panes keep their widths. */}
            <div
              style={
                chatMaximized
                  ? undefined
                  : { width: `calc(${100 - leftWidth}% - ${HANDLE_WIDTH / 2}px)` }
              }
              className={`h-full min-w-0 ${chatMaximized ? "absolute inset-0 z-10 bg-white" : ""}`}
            >
              <ChatArea
                book={book}
                bookError={error as Error | undefined}
                onSelectionClick={handleSelectionClick}
                onOpenBookChat={openBookChat}
              />
            </div>
          </>
        )}
      </main>

      {isNarrow && book && (
        <PageToolbar
          pageCount={book.pageCount}
          highlightCount={book.selections.length}
          chatOpen={chatSheet !== "closed"}
          onToggleChat={() => setChatSheet(chatSheet === "closed" ? "half" : "closed")}
        />
      )}
    </div>
  );
}
