import { describe, it, expect } from "vite-plus/test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { Provider, createStore, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useReadingLocation, type LocatePassage } from "./useReadingLocation";
import { currentPageAtom } from "../atoms/pdfAtom";
import { SwrTestCache } from "../../test/swrTestCache";

const PDF_ID = "01JBOOK";

/** Exposes the URL the hook drives and a way to turn pages like the viewer does. */
function useHarness(locatePassage: LocatePassage, linkedPassage: string | null, visited: string[]) {
  const { passageNotFound } = useReadingLocation(PDF_ID, locatePassage, linkedPassage);

  const { search } = useLocation();
  if (visited[visited.length - 1] !== search) visited.push(search);

  return { search, passageNotFound, setCurrentPage: useSetAtom(currentPageAtom) };
}

function renderAt(
  url: string,
  options: { locatePassage?: LocatePassage; linkedPassage?: string | null } = {},
) {
  const { locatePassage = async () => null, linkedPassage = null } = options;
  const store = createStore();
  // Every distinct URL the hook drives, in order, so tests can tell "landed on
  // page 20" apart from "bounced through page 1 first"
  const visited: string[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache>
      <Provider store={store}>
        <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
      </Provider>
    </SwrTestCache>
  );

  return {
    store,
    visited,
    view: renderHook(() => useHarness(locatePassage, linkedPassage, visited), { wrapper }),
  };
}

describe("useReadingLocation", () => {
  it("opens the page named in the URL so a reload resumes where the reader left off", () => {
    const { store } = renderAt(`/books/${PDF_ID}?page=42`);

    expect(store.get(currentPageAtom)).toBe(42);
  });

  it("writes the page into the URL when the reader turns to it", async () => {
    const { store, view } = renderAt(`/books/${PDF_ID}?page=1`);

    act(() => view.result.current.setCurrentPage(7));

    await waitFor(() => expect(view.result.current.search).toBe("?page=7"));
    expect(store.get(currentPageAtom)).toBe(7);
  });

  it("stays on the page it was given instead of bouncing back to the first one", async () => {
    const { store, visited, view } = renderAt(`/books/${PDF_ID}?page=20`);

    await waitFor(() => expect(view.result.current.search).toBe("?page=20"));

    expect(visited).toEqual(["?page=20"]);
    expect(store.get(currentPageAtom)).toBe(20);
  });

  it("opens the page holding the passage of a browser text-fragment link", async () => {
    const { store } = renderAt(`/books/${PDF_ID}`, {
      linkedPassage: "エッジは速い",
      locatePassage: async (_pdfId, passage) => (passage === "エッジは速い" ? 88 : null),
    });

    await waitFor(() => expect(store.get(currentPageAtom)).toBe(88));
  });

  it("prefers the linked passage over the page the URL names", async () => {
    // A shared "link to highlight" points at a passage; the ?page= it carries
    // is only where the sender happened to be
    const { store } = renderAt(`/books/${PDF_ID}?page=5`, {
      linkedPassage: "エッジは速い",
      locatePassage: async () => 88,
    });

    await waitFor(() => expect(store.get(currentPageAtom)).toBe(88));
  });

  it("stays on the first page when the linked passage is not found in the book", async () => {
    const { store, view } = renderAt(`/books/${PDF_ID}`, {
      linkedPassage: "missing",
      locatePassage: async () => null,
    });

    await waitFor(() => expect(view.result.current.passageNotFound).toBe(true));
    expect(view.result.current.search).toBe("?page=1");
    expect(store.get(currentPageAtom)).toBe(1);
  });

  it("reports a lookup that failed the same way as one that found nothing", async () => {
    // Both leave the reader on page 1 with no idea why the link did not take
    // them to the passage it named.
    const { view } = renderAt(`/books/${PDF_ID}`, {
      linkedPassage: "エッジは速い",
      locatePassage: async () => {
        throw new Error("PDF not found");
      },
    });

    await waitFor(() => expect(view.result.current.passageNotFound).toBe(true));
  });

  it("keeps quiet while the lookup is still running", async () => {
    const { view } = renderAt(`/books/${PDF_ID}`, {
      linkedPassage: "エッジは速い",
      locatePassage: () => new Promise(() => {}),
    });

    expect(view.result.current.passageNotFound).toBe(false);
  });

  it("keeps quiet for a page opened without a linked passage at all", async () => {
    const { view } = renderAt(`/books/${PDF_ID}?page=42`);

    await waitFor(() => expect(view.result.current.search).toBe("?page=42"));
    expect(view.result.current.passageNotFound).toBe(false);
  });
});
