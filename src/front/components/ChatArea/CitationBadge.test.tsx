import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { CitationBadge } from "./CitationBadge";
import { currentPageAtom } from "../../atoms/pdfAtom";
import type { Citation } from "../../../shared/schemas/citation";

function renderBadge(citation: Citation) {
  const store = createStore();
  render(
    <Provider store={store}>
      <CitationBadge citation={citation} />
    </Provider>,
  );
  return store;
}

describe("CitationBadge", () => {
  it("moves the viewer to the cited page when a pdf source is clicked", async () => {
    const store = renderBadge({
      id: "1",
      type: "pdf",
      text: "エッジはサーバーレス実行基盤です",
      pageNumber: 42,
    });

    await userEvent.click(screen.getByRole("button", { name: "出典 [1] のページへ移動" }));

    expect(store.get(currentPageAtom)).toBe(42);
  });

  it("opens a web source in a new tab instead of moving the viewer", () => {
    const store = renderBadge({
      id: "3",
      type: "web",
      text: "Cloudflare Docs",
      url: "https://developers.cloudflare.com/workers/",
    });

    const link = screen.getByRole("link");
    expect([
      link.getAttribute("href"),
      link.getAttribute("target"),
      link.getAttribute("rel"),
    ]).toEqual(["https://developers.cloudflare.com/workers/", "_blank", "noopener noreferrer"]);
    expect(store.get(currentPageAtom)).toBe(1);
  });

  it("offers no jump for a pdf source whose page could not be resolved", () => {
    renderBadge({ id: "2", type: "pdf", text: "どのページか特定できない引用" });

    expect(screen.getByText("[2]")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
