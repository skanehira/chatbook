import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useHighlightSearch, type SearchSelections } from "./useHighlightSearch";
import { SwrTestCache } from "../../test/swrTestCache";
import { ApiError } from "../lib/fetcher";

const BOOK_ID = "p1";
const DEBOUNCE = 200;

/** A search that answers straight away and remembers what it was asked. */
function recordingSearch(answers: Record<string, string[]> = {}) {
  const asked: [string, string][] = [];
  const search: SearchSelections = (pdfId, query) => {
    asked.push([pdfId, query]);
    return Promise.resolve({ selectionIds: answers[query] ?? [] });
  };

  return { search, asked };
}

function renderSearch(search: SearchSelections, pdfId: string | undefined) {
  return renderHook(() => useHighlightSearch(pdfId, search, DEBOUNCE), {
    wrapper: ({ children }: { children: ReactNode }) => <SwrTestCache>{children}</SwrTestCache>,
  });
}

/** Fake timers that still let real time pass, so `waitFor` can settle. */
function useDebounceTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

/** Types into the box and lets the debounce run out. */
async function typeAndSettle(
  view: { result: { current: { setQuery: (q: string) => void } } },
  q: string,
) {
  await act(async () => {
    view.result.current.setQuery(q);
  });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE);
  });
}

describe("useHighlightSearch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches nothing in particular before the reader has searched", () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch();

    const view = renderSearch(search, BOOK_ID);

    expect(view.result.current.matchedIds).toBeNull();
    expect(view.result.current.query).toBe("");
    expect(asked).toStrictEqual([]);
  });

  it("asks the server which highlights hold what the reader typed", async () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch({ エッジ: ["s1", "s3"] });
    const view = renderSearch(search, BOOK_ID);

    await typeAndSettle(view, "エッジ");

    await waitFor(() =>
      expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1", "s3"])),
    );
    expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]);
  });

  it("waits for the typing to stop before asking, so a word is one search", async () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);

    await act(async () => {
      view.result.current.setQuery("エ");
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE - 1);
    });
    expect(asked).toStrictEqual([]);

    await typeAndSettle(view, "エッジ");

    await waitFor(() => expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]));
  });

  it("shows the box as typed while the search is still catching up", async () => {
    useDebounceTimers();
    const { search } = recordingSearch();
    const view = renderSearch(search, BOOK_ID);

    await act(async () => {
      view.result.current.setQuery("エッジ");
    });

    expect(view.result.current.query).toBe("エッジ");
  });

  it("matches nothing in particular again once the box is cleared", async () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);
    await typeAndSettle(view, "エッジ");
    await waitFor(() => expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1"])));

    await typeAndSettle(view, "");

    await waitFor(() => expect(view.result.current.matchedIds).toBeNull());
    expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]);
  });

  it("does not search on spaces alone, which name no passage", async () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch();
    const view = renderSearch(search, BOOK_ID);

    await typeAndSettle(view, "   ");

    expect(asked).toStrictEqual([]);
    expect(view.result.current.matchedIds).toBeNull();
  });

  it("hands back the reason when the search itself fails", async () => {
    useDebounceTimers();
    const refusing: SearchSelections = () =>
      Promise.reject(new ApiError("Unexpected server error", "INTERNAL_ERROR", 500));
    const view = renderSearch(refusing, BOOK_ID);

    await typeAndSettle(view, "エッジ");

    await waitFor(() => expect(view.result.current.searchError).toBe("Unexpected server error"));
    // Nothing is hidden on the strength of a search that did not happen
    expect(view.result.current.matchedIds).toBeNull();
  });

  it("has nothing to search before a book is open", async () => {
    useDebounceTimers();
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, undefined);

    await typeAndSettle(view, "エッジ");

    expect(asked).toStrictEqual([]);
    expect(view.result.current.matchedIds).toBeNull();
  });
});
