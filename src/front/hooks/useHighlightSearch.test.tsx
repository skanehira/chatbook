import { describe, it, expect } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useHighlightSearch, type SearchSelections } from "./useHighlightSearch";
import { SwrTestCache } from "../../test/swrTestCache";
import { ApiError } from "../lib/fetcher";

const BOOK_ID = "p1";

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
  return renderHook(() => useHighlightSearch(pdfId, search), {
    wrapper: ({ children }: { children: ReactNode }) => <SwrTestCache>{children}</SwrTestCache>,
  });
}

type SearchView = ReturnType<typeof renderSearch>;

/** Types into the box without asking for the search to run. */
async function type(view: SearchView, query: string) {
  await act(async () => {
    view.result.current.setQuery(query);
  });
}

/** Takes the reader's word for it that the box is ready. */
async function runSearch(view: SearchView) {
  await act(async () => {
    view.result.current.submit();
  });
}

describe("useHighlightSearch", () => {
  it("matches nothing in particular before the reader has searched", () => {
    const { search, asked } = recordingSearch();

    const view = renderSearch(search, BOOK_ID);

    expect(view.result.current.matchedIds).toBeNull();
    expect(view.result.current.query).toBe("");
    expect(asked).toStrictEqual([]);
  });

  it("leaves the list alone until the reader asks for the search", async () => {
    // The whole point of the button: a half-typed word is not a search.
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);

    await type(view, "エッジ");

    expect(asked).toStrictEqual([]);
    expect(view.result.current.matchedIds).toBeNull();
    expect(view.result.current.query).toBe("エッジ");
  });

  it("asks the server which highlights hold the query once the search is run", async () => {
    const { search, asked } = recordingSearch({ エッジ: ["s1", "s3"] });
    const view = renderSearch(search, BOOK_ID);

    await type(view, "エッジ");
    await runSearch(view);

    await waitFor(() =>
      expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1", "s3"])),
    );
    expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]);
  });

  it("keeps the last result while the box is edited but not run again", async () => {
    const { search } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);
    await type(view, "エッジ");
    await runSearch(view);
    await waitFor(() => expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1"])));

    await type(view, "エッジは");

    expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1"]));
  });

  it("ignores the spaces around what the reader typed", async () => {
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);

    await type(view, "  エッジ  ");
    await runSearch(view);

    await waitFor(() => expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]));
  });

  it("matches nothing in particular again when an empty box is run", async () => {
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, BOOK_ID);
    await type(view, "エッジ");
    await runSearch(view);
    await waitFor(() => expect(view.result.current.matchedIds).toStrictEqual(new Set(["s1"])));

    await type(view, "");
    await runSearch(view);

    await waitFor(() => expect(view.result.current.matchedIds).toBeNull());
    expect(asked).toStrictEqual([[BOOK_ID, "エッジ"]]);
  });

  it("does not search on spaces alone, which name no passage", async () => {
    const { search, asked } = recordingSearch();
    const view = renderSearch(search, BOOK_ID);

    await type(view, "   ");
    await runSearch(view);

    expect(asked).toStrictEqual([]);
    expect(view.result.current.matchedIds).toBeNull();
  });

  it("hands back the reason when the search itself fails", async () => {
    const refusing: SearchSelections = () =>
      Promise.reject(new ApiError("Unexpected server error", "INTERNAL_ERROR", 500));
    const view = renderSearch(refusing, BOOK_ID);

    await type(view, "エッジ");
    await runSearch(view);

    await waitFor(() => expect(view.result.current.searchError).toBe("Unexpected server error"));
    // Nothing is hidden on the strength of a search that did not happen
    expect(view.result.current.matchedIds).toBeNull();
  });

  it("has nothing to search before a book is open", async () => {
    const { search, asked } = recordingSearch({ エッジ: ["s1"] });
    const view = renderSearch(search, undefined);

    await type(view, "エッジ");
    await runSearch(view);

    expect(asked).toStrictEqual([]);
    expect(view.result.current.matchedIds).toBeNull();
  });
});
