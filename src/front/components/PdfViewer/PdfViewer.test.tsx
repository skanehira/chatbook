import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { PdfViewer, type MeasureSelection } from "./PdfViewer";
import { SwrTestCache } from "../../../test/swrTestCache";
import { bookKey } from "../../hooks/useBook";
import { ApiError } from "../../lib/fetcher";
import type { SaveSelection } from "../../hooks/useAskAboutSelection";
import type { BookDetail } from "../../../shared/schemas/book";
import type { CreatedSelection } from "../../../shared/schemas/selection";

const BOOK: BookDetail = {
  id: "p1",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  selections: [],
};

/** Answers the request for the book's binary with the given refusal. */
function bucketWithout(body: unknown, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const PASSAGE = "エッジはサーバーレス実行基盤です。";

/** A passage the reader has dragged over, as the real measurement reports it. */
const MEASURED: ReturnType<MeasureSelection> = {
  position: { x: 40, y: 120, width: 160 },
  selectedText: PASSAGE,
  selectionPosition: {
    startIndex: 0,
    endIndex: 12,
    pageNumber: 1,
    rects: [{ x: 40, y: 120, width: 160, height: 18 }],
    pageWidth: 600,
  },
};

const STORED: CreatedSelection = {
  id: "s1",
  selectedText: PASSAGE,
  pageNumber: 1,
  positionData: MEASURED.selectionPosition,
  createdAt: "2026-08-01T10:00:00.000Z",
};

function renderViewer(
  options: { measureSelection?: MeasureSelection; saveSelection?: SaveSelection } = {},
) {
  return render(
    <SwrTestCache seed={{ [bookKey(BOOK.id)]: BOOK }}>
      <Provider store={createStore()}>
        <PdfViewer
          book={BOOK}
          bookError={undefined}
          onSelectionClick={() => {}}
          measureSelection={options.measureSelection}
          saveSelection={options.saveSelection}
        />
      </Provider>
    </SwrTestCache>,
  );
}

/**
 * Drag over a passage, the way a reader does.
 *
 * The viewer reads the selection on a timer after mouseup (the browser has not
 * settled the selection yet at that point), so the wait is part of the gesture.
 */
async function selectPassage(container: HTMLElement) {
  fireEvent.mouseUp(container.firstElementChild!);
  return screen.findByPlaceholderText("選択した文章について質問する...");
}

describe("PdfViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says why the book cannot be shown instead of opening to a blank page", async () => {
    // The book itself loaded, so none of the other messages apply: without this
    // one the reader is left looking at an empty panel under a page counter.
    vi.stubGlobal(
      "fetch",
      bucketWithout(
        { error: { code: "PDF_FILE_MISSING", message: "PDF binary not found in storage" } },
        404,
      ),
    );

    renderViewer();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^PDFを表示できません: PDF binary not found in storage$/,
    );
  });

  it("says the highlight could not be saved and keeps the question in reach", async () => {
    // The issue's symptom was the opposite: the popover closed on submit, so a
    // failed save took the typed question with it and said nothing.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
    });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    expect(
      await screen.findByText("ハイライトを保存できませんでした: PDF not found"),
    ).toBeVisible();
    // The question is still there to send again
    expect(screen.getByPlaceholderText("選択した文章について質問する...")).toHaveValue(
      "この段落を一言で要約して",
    );
  });

  it("closes the popover once the highlight is stored", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => okAsync(STORED),
    });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("選択した文章について質問する...")).toBeNull(),
    );
    expect(screen.queryByText(/^ハイライトを保存できませんでした/)).toBeNull();
  });

  it("stores one highlight however many times the reader submits while the save is in flight", async () => {
    // The popover now outlives the submit, so only its own gate stops a second
    // ask storing a second highlight and starting an answer that aborts the
    // first one.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const saves: string[] = [];
    let storeIt!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      storeIt = resolve;
    });
    const saveSelection: SaveSelection = (pdfId) => {
      saves.push(pdfId);
      return new ResultAsync(inFlight);
    };
    const { container } = renderViewer({ measureSelection: () => MEASURED, saveSelection });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    // While it is saving, neither route in starts a second one
    await userEvent.click(await screen.findByRole("button", { name: "送信中..." }));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(saves).toStrictEqual([BOOK.id]);

    await act(async () => {
      storeIt(ok(STORED));
    });
  });
});
