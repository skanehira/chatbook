import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { okAsync, errAsync } from "neverthrow";
import type { ReactNode } from "react";
import { useReadingStateSync, type SaveReadingState } from "./useReadingStateSync";
import { currentPageAtom, outlineOpenAtom } from "../atoms/pdfAtom";
import { activeSelectionAtom, bookChatOpenAtom, chatPanelOpenAtom } from "../atoms/chatAtom";
import { ApiError } from "../lib/fetcher";
import { setViewportWidth, PHONE_WIDTH } from "../../test/viewport";
import type { SaveReadingStateRequest } from "../../shared/schemas/book";

const PDF_ID = "01JBOOK";

/** Long enough that a turn taken during it is plainly still being waited on. */
const DEBOUNCE = 50;

const HIGHLIGHT = {
  id: "a2",
  selectedText: "V8 isolate",
  pageNumber: 30,
};

interface Recorded {
  pdfId: string;
  place: SaveReadingStateRequest;
  keepalive: boolean;
}

/**
 * Mounts the sync over a store the test writes to, standing in for the reader
 * turning pages, opening chats and folding the outline away.
 */
function syncHarness({
  locationReady = true,
  outcomes = [] as ("ok" | "fail")[],
}: { locationReady?: boolean; outcomes?: ("ok" | "fail")[] } = {}) {
  const store = createStore();
  const saves: Recorded[] = [];
  let attempt = 0;

  const save: SaveReadingState = (pdfId, place, options) => {
    saves.push({ pdfId, place, keepalive: options?.keepalive === true });
    return (outcomes[attempt++] ?? "ok") === "ok"
      ? okAsync({ saved: true as const })
      : errAsync(new ApiError("回線が切れました", "NETWORK_ERROR", 0, "network"));
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  const view = renderHook(
    ({ ready }: { ready: boolean }) => useReadingStateSync(PDF_ID, ready, save, DEBOUNCE),
    { wrapper, initialProps: { ready: locationReady } },
  );

  /** Turn a page and let the wait for the next one run out. */
  const turnTo = async (page: number) => {
    act(() => store.set(currentPageAtom, page));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
  };

  return { store, saves, view, turnTo };
}

describe("useReadingStateSync", () => {
  // The wait before a turned page is saved is the thing under test, so it is
  // driven by hand rather than lived through.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves the page the reader turned to, so another device opens the book there", async () => {
    const { saves, turnTo } = syncHarness();

    await turnTo(17);

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 17,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("saves the chat the reader opened along with the page it was opened on", async () => {
    const { store, saves } = syncHarness();

    act(() => {
      store.set(currentPageAtom, 30);
      store.set(activeSelectionAtom, HIGHLIGHT);
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 30,
          selectionId: "a2",
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("saves that the conversation left open was the book's own", async () => {
    const { store, saves } = syncHarness();

    act(() => {
      store.set(currentPageAtom, 12);
      store.set(bookChatOpenAtom, true);
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 12,
          selectionId: null,
          bookChat: true,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("takes the book's own conversation with it where a narrow screen leaves the panels", async () => {
    // Which conversation was open is part of the place rather than of the
    // panels: a phone has a conversation open on the book too.
    setViewportWidth(PHONE_WIDTH);
    const { store, saves } = syncHarness();

    act(() => {
      store.set(currentPageAtom, 12);
      store.set(bookChatOpenAtom, true);
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: { page: 12, selectionId: null, bookChat: true },
        keepalive: false,
      },
    ]);
  });

  it("keeps quiet while the place is still being restored, and picks up once it is", async () => {
    // Saving here would write page 1 over the very place being restored.
    const { saves, view, turnTo } = syncHarness({ locationReady: false });

    await turnTo(9);
    expect(saves).toStrictEqual([]);

    await act(async () => view.rerender({ ready: true }));
    await turnTo(12);

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 12,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("does not hand the restored place straight back to the server", async () => {
    const { saves, turnTo } = syncHarness();

    // Nothing moved, so the wait passing changes nothing either
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(saves).toStrictEqual([]);

    await turnTo(17);
    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 17,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("saves the page the reader stopped on rather than every one they passed", async () => {
    const { store, saves } = syncHarness();

    act(() => store.set(currentPageAtom, 2));
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE - 1);
      store.set(currentPageAtom, 3);
    });
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE - 1);
      store.set(currentPageAtom, 4);
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 4,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("leaves both panels out of what a narrow screen saves", async () => {
    // Its outline is a drawer that shuts itself on every jump and its chat a
    // sheet; sending those would fold away what a wide screen deliberately
    // opened.
    setViewportWidth(PHONE_WIDTH);
    const { saves, turnTo } = syncHarness();

    await turnTo(17);

    expect(saves).toStrictEqual([
      { pdfId: PDF_ID, place: { page: 17, selectionId: null, bookChat: false }, keepalive: false },
    ]);
  });

  it("saves the outline a wide screen put up", async () => {
    // Both panels start away and are put up by the restore, so moving one is
    // what a reader folding it back does as well as one opening it
    const { store, saves } = syncHarness();

    act(() => store.set(outlineOpenAtom, true));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 1,
          selectionId: null,
          bookChat: false,
          outlineOpen: true,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("saves the chat pane a wide screen put up", async () => {
    const { store, saves } = syncHarness();

    act(() => store.set(chatPanelOpenAtom, true));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 1,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: true,
        },
        keepalive: false,
      },
    ]);
  });

  it("says why a save failed, and stops saying so once the next one lands", async () => {
    const { view, turnTo } = syncHarness({ outcomes: ["fail", "ok"] });

    await turnTo(17);
    expect(view.result.current.saveError).toBe("回線が切れました");

    await turnTo(18);
    expect(view.result.current.saveError).toBeNull();
  });

  it("sends the turn the reader took on their way back to the shelf", async () => {
    // Leaving unmounts the reader before the wait is out, and the page they
    // stopped on is the one worth keeping.
    const { store, saves, view } = syncHarness();

    act(() => store.set(currentPageAtom, 17));
    view.unmount();

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 17,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: true,
      },
    ]);
  });

  it("sends nothing on the way out when the last turn is already saved", async () => {
    const { saves, view, turnTo } = syncHarness();

    await turnTo(17);
    view.unmount();

    // The turn that was already sent is not sent a second time on the way out
    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 17,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: false,
      },
    ]);
  });

  it("sends the pending turn when the tab is closed rather than left", async () => {
    const { store, saves } = syncHarness();

    act(() => store.set(currentPageAtom, 17));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(saves).toStrictEqual([
      {
        pdfId: PDF_ID,
        place: {
          page: 17,
          selectionId: null,
          bookChat: false,
          outlineOpen: false,
          chatPanelOpen: false,
        },
        keepalive: true,
      },
    ]);
  });
});
