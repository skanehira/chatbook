import { describe, it, expect } from "vite-plus/test";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatScopeMenu } from "./ChatScopeMenu";
import type { ScopeChapter } from "../../lib/chatScope";

const PAGE_COUNT = 60;

const FRONT_MATTER: ScopeChapter = { title: null, startPage: 1, endPage: 11 };
const V8: ScopeChapter = { title: "第2章 V8 とアイソレート", startPage: 12, endPage: 34 };
const DURABLE_OBJECTS: ScopeChapter = {
  title: "第3章 Durable Objects",
  startPage: 35,
  endPage: 48,
};
const CHAPTERS = [FRONT_MATTER, V8, DURABLE_OBJECTS];

function menu(
  chapters: ScopeChapter[],
  scope: ScopeChapter[],
  onChange: (scope: ScopeChapter[]) => void = () => {},
) {
  return (
    <ChatScopeMenu chapters={chapters} pageCount={PAGE_COUNT} scope={scope} onChange={onChange} />
  );
}

/** The menu as the panel drives it, so what the reader picks is what it shows. */
function PickedMenu() {
  const [scope, setScope] = useState<ScopeChapter[]>([]);
  return (
    <ChatScopeMenu chapters={CHAPTERS} pageCount={PAGE_COUNT} scope={scope} onChange={setScope} />
  );
}

const trigger = () => screen.getByRole("button", { name: /^範囲:/ });
const wholeBookRow = () => screen.getByRole("button", { name: /^本全体/ });

describe("ChatScopeMenu", () => {
  it("says the whole book is being asked about while nothing is picked", () => {
    render(menu(CHAPTERS, []));

    expect(trigger()).toHaveTextContent("範囲: 本全体");
  });

  it("names the chapters picked, counting the rest", () => {
    render(menu(CHAPTERS, [V8, DURABLE_OBJECTS]));

    expect(trigger()).toHaveTextContent("範囲: 第2章 V8 とアイソレート ほか1件");
  });

  it("lists every chapter with the pages it covers once the reader opens it", async () => {
    render(menu(CHAPTERS, []));

    await userEvent.click(trigger());

    expect(screen.getByText("第2章 V8 とアイソレート")).toBeInTheDocument();
    expect(screen.getByText("12〜34ページ")).toBeInTheDocument();
    expect(screen.getByText("第3章 Durable Objects")).toBeInTheDocument();
    expect(screen.getByText("35〜48ページ")).toBeInTheDocument();
    // The pages ahead of the first chapter are pickable too, under the name the
    // span is given when it has no heading of its own.
    expect(screen.getByText("冒頭")).toBeInTheDocument();
    expect(screen.getByText("1〜11ページ")).toBeInTheDocument();
  });

  it("hands back the chapter the reader checks", async () => {
    const picked: ScopeChapter[][] = [];
    render(menu(CHAPTERS, [], (scope) => picked.push(scope)));

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));

    expect(picked).toStrictEqual([[V8]]);
  });

  it("adds a chapter to the ones already picked, leaving the menu open to pick another", async () => {
    render(<PickedMenu />);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /第3章 Durable Objects/ }));

    expect(trigger()).toHaveTextContent("範囲: 第2章 V8 とアイソレート ほか1件");
    expect(screen.getByRole("checkbox", { name: /第2章 V8/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /第3章 Durable Objects/ })).toBeChecked();
  });

  it("hands the whole book back when the reader asks for it again, and shuts behind it", async () => {
    const picked: ScopeChapter[][] = [];
    render(menu(CHAPTERS, [V8], (scope) => picked.push(scope)));

    await userEvent.click(trigger());
    await userEvent.click(wholeBookRow());

    expect(picked).toStrictEqual([[]]);
    // The whole book is a finished choice, unlike a chapter, which is usually
    // one of several: the menu closes rather than sitting over the thread.
    expect(screen.queryByRole("checkbox", { name: /第2章 V8/ })).toBeNull();
  });

  it("names the chapter that comes first in the book, not the last one checked", async () => {
    render(<PickedMenu />);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("checkbox", { name: /第3章 Durable Objects/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));

    expect(trigger()).toHaveTextContent("範囲: 第2章 V8 とアイソレート ほか1件");
  });

  it("takes a chapter back out when the reader unchecks it", async () => {
    const picked: ScopeChapter[][] = [];
    render(menu(CHAPTERS, [V8, DURABLE_OBJECTS], (scope) => picked.push(scope)));

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));

    expect(picked).toStrictEqual([[DURABLE_OBJECTS]]);
  });

  it("goes back to the whole book when the last chapter is unpicked", async () => {
    // Picking nothing is not an empty question: the chip has to name something
    // the reader can send.
    render(<PickedMenu />);

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /第2章 V8/ }));

    expect(trigger()).toHaveTextContent("範囲: 本全体");
  });

  it("says so, and offers only the whole book, when the book has no table of contents", async () => {
    render(menu([], []));

    await userEvent.click(trigger());

    expect(screen.getByText("この本には目次がありません")).toBeInTheDocument();
    expect(wholeBookRow()).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shuts on Escape, so the keyboard reader is not left in it", async () => {
    render(menu(CHAPTERS, []));

    await userEvent.click(trigger());
    expect(screen.getByRole("checkbox", { name: /第2章 V8/ })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("checkbox", { name: /第2章 V8/ })).toBeNull();
  });

  it("shuts on a click away from it", async () => {
    render(menu(CHAPTERS, []));

    await userEvent.click(trigger());
    expect(screen.getByRole("checkbox", { name: /第2章 V8/ })).toBeInTheDocument();

    await userEvent.click(document.body);

    expect(screen.queryByRole("checkbox", { name: /第2章 V8/ })).toBeNull();
  });
});
