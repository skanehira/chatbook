import { describe, it, expect } from "vite-plus/test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { HighlightListPanel, type HighlightListItem } from "./HighlightListPanel";
import { ApiError } from "../../lib/fetcher";
import type { ActiveSelection } from "../../atoms/chatAtom";

const OLDER: HighlightListItem = {
  id: "01JOLD",
  selectedText: "エッジはサーバーレス実行基盤で、実行単位をまたいでメモリを共有できません。",
  pageNumber: 42,
  color: "#FFEB3B",
  createdAt: "2026-08-01T10:00:00.000Z",
};

const MIDDLE: HighlightListItem = {
  id: "01JMID",
  selectedText: "KV は結果整合で、書き込みが伝わるまで数秒かかります。",
  pageNumber: 88,
  color: "#4CAF50",
  createdAt: "2026-08-02T10:00:00.000Z",
};

const NEWER: HighlightListItem = {
  id: "01JNEW",
  selectedText: "Durable Objects は単一のインスタンスに処理を集約します。",
  pageNumber: 7,
  color: "#2196F3",
  createdAt: "2026-08-03T10:00:00.000Z",
};

const ACCEPTS_EVERY_DELETION = () => okAsync(undefined);

function renderPanel(
  highlights: HighlightListItem[],
  handlers: {
    onSelect?: (selection: ActiveSelection) => void;
    onDelete?: (selectionId: string) => ResultAsync<void, ApiError>;
  } = {},
) {
  return render(
    <HighlightListPanel
      highlights={highlights}
      onSelect={handlers.onSelect ?? (() => {})}
      onDelete={handlers.onDelete ?? ACCEPTS_EVERY_DELETION}
    />,
  );
}

/** The delete button of one row, told apart from the row's own button. */
function deleteButtonOf(highlight: HighlightListItem) {
  const row = screen.getByText(highlight.selectedText).closest("li");
  return within(row as HTMLElement).getByRole("button", { name: /を削除$/ });
}

describe("HighlightListPanel", () => {
  it("shows each highlight with its passage and page, plus how many there are", () => {
    renderPanel([OLDER, NEWER]);

    expect(screen.getByText("ハイライト 2件")).toBeInTheDocument();
    expect(screen.getByText(OLDER.selectedText)).toBeInTheDocument();
    expect(screen.getByText("42ページ")).toBeInTheDocument();
    expect(screen.getByText(NEWER.selectedText)).toBeInTheDocument();
    expect(screen.getByText("7ページ")).toBeInTheDocument();
  });

  it("lists the most recently created highlight first, whatever order they arrive in", () => {
    renderPanel([NEWER, OLDER, MIDDLE]);

    const passages = screen
      .getAllByRole("listitem")
      .map((row) => row.textContent?.replace(/\d+ページ$/, ""));

    expect(passages).toStrictEqual([NEWER.selectedText, MIDDLE.selectedText, OLDER.selectedText]);
  });

  it("hands the clicked highlight to onSelect so its chat can be opened", async () => {
    const selected: unknown[] = [];
    renderPanel([OLDER, NEWER], { onSelect: (h) => selected.push(h) });

    await userEvent.click(screen.getByText(OLDER.selectedText));

    expect(selected).toStrictEqual([
      { id: OLDER.id, selectedText: OLDER.selectedText, pageNumber: OLDER.pageNumber },
    ]);
  });

  it("tells the reader how to start when the book has no highlights yet", () => {
    renderPanel([]);

    expect(screen.getByText("チャットを開始するには")).toBeInTheDocument();
    expect(screen.getByText("PDF内のテキストを選択して質問してください")).toBeInTheDocument();
  });

  it("narrows the list to the passages holding what the reader typed", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);

    await userEvent.type(screen.getByLabelText("ハイライトを検索"), "結果整合");

    expect(screen.getByText("ハイライト 3件中 1件")).toBeInTheDocument();
    expect(screen.getByText(MIDDLE.selectedText)).toBeInTheDocument();
    expect(screen.queryByText(OLDER.selectedText)).not.toBeInTheDocument();
    expect(screen.queryByText(NEWER.selectedText)).not.toBeInTheDocument();
  });

  it("puts every highlight back once the query is cleared", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);
    const search = screen.getByLabelText("ハイライトを検索");

    await userEvent.type(search, "結果整合");
    await userEvent.clear(search);

    expect(screen.getByText("ハイライト 3件")).toBeInTheDocument();
    expect(screen.getByText(OLDER.selectedText)).toBeInTheDocument();
    expect(screen.getByText(MIDDLE.selectedText)).toBeInTheDocument();
    expect(screen.getByText(NEWER.selectedText)).toBeInTheDocument();
  });

  it("narrows the list to the highlights sitting inside the page range", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);

    await userEvent.type(screen.getByLabelText("開始ページ"), "40");
    await userEvent.type(screen.getByLabelText("終了ページ"), "50");

    expect(screen.getByText("ハイライト 3件中 1件")).toBeInTheDocument();
    expect(screen.getByText(OLDER.selectedText)).toBeInTheDocument();
    expect(screen.queryByText(MIDDLE.selectedText)).not.toBeInTheDocument();
    expect(screen.queryByText(NEWER.selectedText)).not.toBeInTheDocument();
  });

  it("narrows by the query and the page range at once", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);

    // "ます" is in the two newer passages, page 40 on holds the two older ones,
    // so only the highlight in both is left.
    await userEvent.type(screen.getByLabelText("ハイライトを検索"), "ます");
    await userEvent.type(screen.getByLabelText("開始ページ"), "40");

    expect(screen.getByText("ハイライト 3件中 1件")).toBeInTheDocument();
    expect(screen.getByText(MIDDLE.selectedText)).toBeInTheDocument();
    expect(screen.queryByText(OLDER.selectedText)).not.toBeInTheDocument();
    expect(screen.queryByText(NEWER.selectedText)).not.toBeInTheDocument();
  });

  it("says nothing matched but keeps the boxes, so the search can be widened again", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);

    await userEvent.type(screen.getByLabelText("ハイライトを検索"), "みつからない語");

    expect(screen.getByText("一致するハイライトがありません")).toBeInTheDocument();
    expect(screen.getByText("ハイライト 3件中 0件")).toBeInTheDocument();
    expect(screen.getByLabelText("ハイライトを検索")).toHaveValue("みつからない語");
  });

  it("asks before deleting, saying the chat goes with the highlight", async () => {
    renderPanel([OLDER]);

    await userEvent.click(deleteButtonOf(OLDER));

    expect(screen.getByRole("alertdialog", { name: "ハイライトの削除" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "このハイライトを削除しますか？このハイライトのチャット履歴も削除されます。",
      ),
    ).toBeInTheDocument();
  });

  it("deletes the highlight whose removal the reader confirmed", async () => {
    const deleted: string[] = [];
    renderPanel([OLDER, NEWER], {
      onDelete: (id) => {
        deleted.push(id);
        return okAsync(undefined);
      },
    });

    await userEvent.click(deleteButtonOf(OLDER));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(deleted).toStrictEqual([OLDER.id]);
  });

  it("deletes nothing when the reader cancels", async () => {
    const deleted: string[] = [];
    renderPanel([OLDER], {
      onDelete: (id) => {
        deleted.push(id);
        return okAsync(undefined);
      },
    });

    await userEvent.click(deleteButtonOf(OLDER));
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(deleted).toStrictEqual([]);
    expect(screen.getByText(OLDER.selectedText)).toBeInTheDocument();
  });

  it("keeps the highlight and says why when the server refuses to delete it", async () => {
    renderPanel([OLDER], {
      onDelete: () => errAsync(new ApiError("Unexpected server error", "INTERNAL_ERROR", 500)),
    });

    await userEvent.click(deleteButtonOf(OLDER));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "削除に失敗しました: Unexpected server error",
    );
    expect(screen.getByText(OLDER.selectedText)).toBeInTheDocument();
  });

  it("opens no chat when the reader reaches for a highlight's delete button", async () => {
    const selected: unknown[] = [];
    renderPanel([OLDER], { onSelect: (h) => selected.push(h) });

    await userEvent.click(deleteButtonOf(OLDER));

    expect(screen.getByRole("alertdialog", { name: "ハイライトの削除" })).toBeInTheDocument();
    expect(selected).toStrictEqual([]);
  });

  it("keeps the list narrowed after a highlight is deleted out of it", async () => {
    renderPanel([OLDER, MIDDLE, NEWER]);
    await userEvent.type(screen.getByLabelText("ハイライトを検索"), "結果整合");

    await userEvent.click(deleteButtonOf(MIDDLE));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(screen.getByLabelText("ハイライトを検索")).toHaveValue("結果整合");
    expect(screen.getByText("ハイライト 3件中 1件")).toBeInTheDocument();
  });
});
