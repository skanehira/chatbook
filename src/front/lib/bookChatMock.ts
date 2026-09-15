/**
 * MOCK — delete this file once the server side of the book's own conversation
 * exists.
 *
 * Two things the screen cannot get from anywhere else are faked here: the pages
 * each chapter covers, and the answer itself. Everything around them — the
 * atoms, the scope menu, the panel's third face — is the real thing, so what a
 * reader judges by using it is what will ship.
 */
import type { BookOutline } from "../../shared/schemas/book";
import { chapterLabel, pageRangeLabel, type ScopeChapter } from "./chatScope";

/** How much of the answer arrives at a time, and how often. */
const CHARS_PER_TICK = 3;
const TICK_MS = 24;

/**
 * The span each chapter covers, with the pages ahead of the first chapter as a
 * headingless one of their own.
 *
 * MOCK: the server holds the very same outline — it was stored at upload — and
 * will cut excerpts by it, so this belongs beside the cutter rather than here.
 * Until then the ranges are worked out from the reader's own copy, which is the
 * only one to hand.
 */
export function spansFromOutline(chapters: BookOutline | null, pageCount: number): ScopeChapter[] {
  if (chapters === null || pageCount < 1) return [];

  // Two headings naming the same page are one chapter: the later one has
  // nowhere of its own to start, and a chapter with no pages cannot be picked.
  const byStartPage = new Map<number, string>();
  for (const chapter of chapters) {
    if (chapter.pageNumber < 1 || chapter.pageNumber > pageCount) continue;
    if (!byStartPage.has(chapter.pageNumber)) byStartPage.set(chapter.pageNumber, chapter.title);
  }

  const starts = [...byStartPage.keys()].sort((a, b) => a - b);
  // No usable heading is the same as no outline: the whole book is not a
  // chapter, and calling it one would leave the reader a single unnamed span
  // where the fallback is the book itself.
  if (starts.length === 0) return [];

  // The pages ahead of the first chapter are a span of their own, with no
  // heading to be named by — unless the book opens on a chapter already.
  const bounds = starts[0] === 1 ? starts : [1, ...starts];

  return bounds.map((startPage, index) => ({
    title: byStartPage.get(startPage) ?? null,
    startPage,
    // Up to the page before the next chapter starts, and the end of the book
    // for the last one.
    endPage: index + 1 < bounds.length ? bounds[index + 1] - 1 : pageCount,
  }));
}

export interface MockReplyOptions {
  question: string;
  scope: ScopeChapter[];
  pageCount: number;
  /**
   * The same signal the real stream is given, so that leaving the chat — which
   * aborts through `abortChatStreamAtom` — stops this one the same way.
   */
  signal: AbortSignal;
  onToken: (token: string) => void;
  /** Handed the finished answer, as the real stream's `done` hands its over. */
  onDone: (answer: string) => void;
}

/**
 * Stream a canned answer for the scope the reader picked, a few characters at a
 * time so the thread fills the way a real one does.
 *
 * MOCK: no model is asked and nothing is stored, so the thread is gone on
 * reload. The first line names the scope the question was asked under, which is
 * the one thing about this screen that cannot be judged by looking at it.
 */
export function mockBookReply(options: MockReplyOptions): void {
  const { signal, onToken, onDone } = options;
  const answer = mockAnswer(options.question, options.scope, options.pageCount);
  const pieces = chunk(answer);
  let index = 0;

  const timer = setInterval(() => {
    const piece = pieces[index];
    index += 1;
    if (piece === undefined) {
      clearInterval(timer);
      onDone(answer);
      return;
    }
    onToken(piece);
  }, TICK_MS);

  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

function chunk(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += CHARS_PER_TICK) {
    pieces.push(text.slice(start, start + CHARS_PER_TICK));
  }
  return pieces;
}

function mockAnswer(question: string, scope: ScopeChapter[], pageCount: number): string {
  const pages =
    scope.length === 0
      ? pageRangeLabel({ startPage: 1, endPage: pageCount })
      : scope.map(pageRangeLabel).join("、");
  const target =
    scope.length === 0 ? `本全体（${pages}）` : `${scope.map(chapterLabel).join("、")}（${pages}）`;
  const closing =
    scope.length === 0
      ? "> 章を選ぶと、その章だけを根拠にした回答に切り替わります。"
      : "> 範囲を「本全体」に戻すと、章をまたいだ比較も同じ質問で出せます。";

  return `※モック回答（対象: ${target}）

「${question}」について、対象の範囲から読み取れることをまとめます。

1. **分離の単位** — 各アイソレートは独立した V8 インスタンスで動き、メモリを共有しません。
2. **状態の置き場所** — プロセスに状態を持たせず、Durable Objects や KV に寄せる方針が繰り返し示されています。
3. **起動時間** — 分離の代償としてコールドスタートに触れ、実測値が表で整理されています。

| 仕組み | 状態の持ち方 | 向いている用途 |
| --- | --- | --- |
| Workers | 持たない | ステートレスな処理 |
| Durable Objects | インスタンスに持つ | 一貫性が要る調整 |
| KV | 外部に持つ | 読みが多い設定値 |

${closing}`;
}
