import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIGURE_PAGE,
  FIXTURE_FILE_NAME,
  FIXTURE_TITLE,
  OUTLINE,
  PAGE_COUNT,
  pageText,
} from "./fixtures/testBookManifest.ts";
// Taken from the viewer rather than copied: a wait written as a number here
// would stay put if the viewer's own wait grew, and quietly stop covering it.
import { SELECTION_SETTLE_MS } from "../src/front/hooks/useSettledSelection.ts";

/**
 * The book these tests read, drawn by `fixtures/generateTestBook.ts` and
 * committed alongside it. Everything asserted about it — the page count, the
 * outline, the figure page — comes from `fixtures/testBookManifest.ts`.
 */
const TEST_PDF = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  FIXTURE_FILE_NAME,
);

/**
 * The text of page `pageNumber`, which is in the document only while that page
 * is the one drawn.
 *
 * `PdfPage` labels every span with the page it came from, after `textLayer.render()`
 * has returned (`src/front/components/PdfViewer/PdfPage.tsx`), and the layer is
 * built again on each turn. Both halves matter: the label arriving only once the
 * page is drawn is what makes this a readiness signal, where the page counter —
 * which is not drawn for a mouse — only ever said which page was meant.
 */
function drawnPage(page: Page, pageNumber: number): Locator {
  return page.locator(`.textLayer span[data-page-number="${pageNumber}"]`);
}

/**
 * A book of an API test's own, as a multipart file field.
 *
 * A re-open overwrites the stored metadata, so posting the fixture's own bytes
 * with a placeholder fullText would wipe the extracted text of the book the
 * other tests are reading, which the citation and text-fragment lookups need. A
 * trailing PDF comment keeps the file valid while giving it a hash of its own,
 * and the distinct name keeps these books apart from the fixture on the shelf.
 */
function apiFixtureFile(tag: string) {
  return {
    name: `${tag}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.concat([fs.readFileSync(TEST_PDF), Buffer.from(`\n%${tag}\n`)]),
  };
}

/**
 * Upload the fixture book (idempotent by hash) and land in the reader.
 *
 * The run starts from an empty store, but highlights persist for the rest of
 * it, and they sit above the text layer to stay clickable. Leftovers from an
 * earlier test would cover the text and block selection, so start every test
 * from a book with no highlights.
 */
/**
 * Sign in, so the rest of the run can reach the API.
 *
 * The credentials are the ones `.dev.vars` carries for local development; the
 * deployed app has a password of its own that never appears here.
 */
async function logIn(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "demo", password: "demo" },
  });
  expect(response.status()).toBe(200);
}

/** The place the book reports, as much of it as the reset has to undo. */
type StoredPlace = {
  page: number;
  outlineOpen: boolean | null;
  chatPanelOpen: boolean | null;
} | null;

/** Whether the book would open somewhere other than where the reset leaves it. */
function resumedElsewhere(place: StoredPlace): boolean {
  return (
    place !== null &&
    (place.page !== 1 || place.outlineOpen === false || place.chatPanelOpen === false)
  );
}

/**
 * Folds the chat pane away, which is the server's answer now rather than the
 * URL's. Written before the book is opened so the restore brings it up folded.
 */
async function foldChatPane(page: Page, pdfId: string): Promise<void> {
  await page.request.put(`/api/pdf/${pdfId}/reading-state`, {
    data: { page: 1, selectionId: null, chatPanelOpen: false },
  });
}

/**
 * Long enough that a save the reader's landing would have triggered has been
 * sent: the debounce is a second, and nothing is written after it.
 */
const SAVE_SETTLE_MS = 2000;

/**
 * Long enough that anything drawn along with a page has been. Used where the
 * point is that something did *not* come back with it, which no single look can
 * tell from having looked too early.
 */
const REDRAW_SETTLE_MS = 500;

/** The reader's place reaching the server, a second after they moved it. */
function placeSaved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/reading-state") &&
      response.request().method() === "PUT" &&
      response.ok(),
  );
}

async function openTestBook(page: Page): Promise<string> {
  await logIn(page);
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', TEST_PDF);
  await expect(page).toHaveURL(/\/books\//, { timeout: 60000 });

  const pdfId = new URL(page.url()).pathname.split("/").pop()!;
  const { selections, readingState } = (await (
    await page.request.get(`/api/pdf/${pdfId}`)
  ).json()) as {
    selections: { id: string }[];
    readingState: StoredPlace;
  };
  for (const selection of selections) {
    await page.request.delete(`/api/pdf/${pdfId}/selections/${selection.id}`);
  }

  // The three specs share this book, and the reader's place — both panels
  // included — is kept on the server now: uploading goes through the shelf,
  // which names no page, so an earlier test's place would be where this one
  // opens.
  await page.request.put(`/api/pdf/${pdfId}/reading-state`, {
    data: { page: 1, selectionId: null, outlineOpen: true, chatPanelOpen: true },
  });

  // Reload only where the reader is showing something the reset has just
  // replaced: a second load of the book costs as much as the first one.
  if (selections.length > 0 || resumedElsewhere(readingState)) {
    await page.goto(`/books/${pdfId}?page=1`);
  }
  // A tap or a drag needs the page itself to have been drawn, not merely the
  // book to have arrived.
  await expect(page.locator("canvas.block")).toBeVisible({ timeout: 60000 });
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });
  return pdfId;
}

/**
 * How far the page pane is scrolled. The pane is found from the canvas rather
 * than by class name, and -1 is returned when nothing overflows — a scroll
 * assertion against a pane that cannot scroll would pass no matter what.
 */
async function pageScrollTop(page: Page): Promise<number> {
  return page
    .locator("canvas.block")
    .first()
    .evaluate((canvas) => {
      let el = canvas.parentElement;
      while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
      return el ? el.scrollTop : -1;
    });
}

/**
 * The cover page carries almost no selectable text, so step forward until the
 * rendered page has a text layer worth dragging across.
 *
 * Turning with the keyboard rather than the edge of the page: the edges refuse a
 * turn while a selection is up, and a test that has just made one still needs to
 * be able to move. Called from the first page, which is what `openTestBook`
 * leaves behind, so the page each turn lands on is known and can be waited for —
 * a drag measured while pdf.js is still swapping text layers lands on nothing.
 */
async function goToPageWithText(page: Page, minSpans = 5) {
  const spans = page.locator(".textLayer span");
  for (let i = 0; i < 15; i++) {
    if ((await spans.count()) >= minSpans) return;
    await page.keyboard.press("l");
    await expect(drawnPage(page, i + 2).first()).toBeVisible();
  }
  throw new Error("no page with a text layer was found");
}

test("app loads and shows the shelf", async ({ page }) => {
  await logIn(page);
  await page.goto("/");
  await expect(page.locator("text=chatbook")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDFを追加" })).toBeVisible();
});

/** Console output naming a pdf.js asset the viewer failed to fetch. */
function collectFontErrors(page: Page): string[] {
  const fontErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("cMapUrl") || text.includes("standardFontDataUrl")) {
      fontErrors.push(text);
    }
  });
  return fontErrors;
}

/**
 * The share of the rendered page that is not white. A blank canvas means the
 * fonts (CMap / standard font data) failed to load.
 */
async function inkRatio(page: Page): Promise<number> {
  const canvas = page.locator("canvas.block").first();
  await expect(canvas).toBeVisible({ timeout: 60000 });
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) ink++;
    }
    return ink / (data.length / 4);
  });
}

test("adding a PDF from the shelf opens the reader and renders its pages", async ({ page }) => {
  await logIn(page);
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', TEST_PDF);

  // Uploading navigates into the reader for that book, on its first page. The
  // panels are the book's own answer and are nowhere in the address bar.
  await expect(page).toHaveURL(/\/books\/[A-Z0-9]+\?page=1$/, {
    timeout: 60000,
  });

  // The page count is the browser's own reading of the file, and the book it
  // stored is where that shows now: the counter that used to say it is not
  // drawn for a mouse.
  const pdfId = new URL(page.url()).pathname.split("/").pop()!;
  const stored = (await (await page.request.get(`/api/pdf/${pdfId}`)).json()) as {
    pageCount: number;
  };
  expect(stored.pageCount).toBe(PAGE_COUNT);

  // The cover is text on white, so ink means the glyphs were drawn
  expect(await inkRatio(page)).toBeGreaterThan(0.001);
});

/**
 * `test-book.pdf` embeds every Japanese glyph it draws, so pdf.js reads it
 * without a predefined CMap and would pass this test with `cMapUrl` removed.
 * This second book names `UniJIS-UCS2-H` as its font's encoding the way a book
 * from a publisher does, which pdf.js can resolve only by fetching the CMap
 * tables — for the glyphs and for reading the text out. Drawn by
 * `fixtures/generateCidFontBook.ts` and committed alongside it.
 */
const CID_FONT_BOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "cid-font-book.pdf",
);

test("a book with CID-keyed fonts renders without asking for a CMap", async ({ page }) => {
  await logIn(page);

  const fontErrors = collectFontErrors(page);

  await page.goto("/");
  await page.setInputFiles('input[type="file"]', CID_FONT_BOOK);
  await expect(page).toHaveURL(/\/books\//, { timeout: 60000 });

  expect(await inkRatio(page)).toBeGreaterThan(0.001);
  expect(fontErrors).toStrictEqual([]);
});

test("the shelf lists the book with a real cover image, sizes every card alike, and opens it", async ({
  page,
}) => {
  await logIn(page);
  // Make sure the book exists on the shelf (upload is idempotent by hash)
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', TEST_PDF);
  await expect(page).toHaveURL(/\/books\//, { timeout: 60000 });

  // A second book with no thumbnail, so the shelf falls back to the title
  // placeholder. The placeholder is laid out from its text, which is what made
  // the cards differ in size from each other.
  await page.request.post("/api/pdf/open", {
    multipart: {
      file: apiFixtureFile("shelf-card-size"),
      fullText: "A book stored without a cover image.",
      pageCount: String(PAGE_COUNT),
    },
  });

  await page.goto("/");

  // Earlier runs may have left books of the same name on the shelf, so take the
  // first match rather than requiring the title to be unique
  const cover = page.getByRole("img", { name: `${FIXTURE_TITLE} の表紙` }).first();
  await expect(cover).toBeVisible({ timeout: 30000 });

  // The <img> must actually decode; a broken cover URL would still be "visible"
  await expect
    .poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30000 })
    .toBeGreaterThan(0);

  // Both a cover and a placeholder are on the shelf now, so comparing the card
  // sizes covers the case that used to break
  await expect(page.getByRole("button", { name: "shelf-card-size" }).first()).toBeVisible();

  const cardSizes = await page.locator("ul li button > div").evaluateAll((els) =>
    els.map((el) => {
      const { width, height } = el.getBoundingClientRect();
      return `${Math.round(width)}x${Math.round(height)}`;
    }),
  );

  expect(cardSizes.length).toBeGreaterThan(1);
  expect(new Set(cardSizes)).toStrictEqual(new Set([cardSizes[0]]));
  expect(cardSizes[0]).not.toBe("0x0");

  await page.getByRole("button", { name: FIXTURE_TITLE }).first().click();
  await expect(page).toHaveURL(/\/books\//);
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });
});

test("reloading the reader keeps the book open", async ({ page }) => {
  await logIn(page);
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', TEST_PDF);
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });

  await page.reload();

  // Restored from the URL, not from the upload that filled the atom
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });
});

/**
 * The rendered page width once it stops changing.
 *
 * Fitting the page to the panel goes through a ResizeObserver and a re-render,
 * so the canvas keeps an earlier size for a moment after the layout settles.
 *
 * The leftmost page when two are up: both are drawn at the same scale, and it
 * is the one that is there whether there is room for a second or not.
 */
/**
 * How many text-layer spans there are, once that number has stopped changing.
 *
 * pdf.js fills the layer in after the canvas is drawn, so a drag measured off
 * the first spans to arrive works from half a page.
 */
async function settledSpanCount(page: Page): Promise<number> {
  const spans = page.locator(".textLayer span");
  let previous = -1;

  for (let i = 0; i < 25; i++) {
    const count = await spans.count();
    if (count > 0 && count === previous) return count;
    previous = count;
    await page.waitForTimeout(200);
  }
  throw new Error("the text layer never settled on a number of spans");
}

async function settledCanvasWidth(page: Page): Promise<number> {
  const canvas = page.locator("canvas.block").first();
  let previous = -1;

  for (let i = 0; i < 25; i++) {
    const width = (await canvas.boundingBox())!.width;
    if (width === previous) return width;
    previous = width;
    await page.waitForTimeout(200);
  }
  throw new Error("the rendered page never settled on a width");
}

/**
 * The drawn page next to the area it is drawn into, both settled.
 *
 * The pane is found by walking up from the canvas to the element that scrolls,
 * so this does not depend on the viewer's class names, and its padding is taken
 * off: that is the room the page actually has. `wastedUnderPage` is what is left
 * of the pane's own height below the page, over and above the gutter the pane
 * deliberately keeps — read from the pane rather than written down here, so
 * changing the gutter does not turn this into a failure.
 */
async function drawnPageAndPane(page: Page) {
  await settledCanvasWidth(page);

  return page
    .locator("canvas.block")
    .first()
    .evaluate((canvas) => {
      let pane = canvas.parentElement;
      while (pane && getComputedStyle(pane).overflowY !== "auto") pane = pane.parentElement;
      if (!pane) throw new Error("the scrolling pane around the page was not found");

      const style = getComputedStyle(pane);
      const gutterBelow = parseFloat(style.paddingBottom);
      const box = canvas.getBoundingClientRect();
      return {
        page: { width: box.width, height: box.height },
        pane: {
          width: pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          height:
            pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        },
        wastedUnderPage: pane.getBoundingClientRect().bottom - box.bottom - gutterBelow,
      };
    });
}

/**
 * The page measured against the pane it is fitted into.
 *
 * `fills` is how much of the pane the page takes along its longer axis: fitting
 * means growing until one edge is reached, so a fitted page sits at 1. Under
 * that the page is drawn smaller than it could be, over it the page is clipped,
 * and `overflows` says which by how many pixels.
 */
async function pageAgainstPane(page: Page) {
  const { page: drawn, pane } = await drawnPageAndPane(page);
  return {
    fills: Math.max(drawn.width / pane.width, drawn.height / pane.height),
    overflows: Math.max(drawn.width - pane.width, drawn.height - pane.height),
    width: drawn.width,
  };
}

test("the whole page is visible whether the chat panel is open or folded away", async ({
  page,
}) => {
  await openTestBook(page);

  // Fitting on width alone drew the page taller than the pane, so the foot of
  // every page was off screen — worse the wider the pane got.
  const withPanel = await pageAgainstPane(page);
  expect(withPanel.width).toBeGreaterThan(0);
  expect(withPanel.overflows).toBeLessThanOrEqual(0);
  // ...and the pane is what decides the size, not some scale that merely fits
  expect(withPanel.fills).toBeGreaterThan(0.98);

  await page.getByRole("button", { name: "チャットを隠す" }).click();

  // Folding the chat away at this window size leaves room for two pages, so
  // what has to stay inside the pane is the pair of them (see "puts a second
  // page up…" for what else that promises).
  await expect(drawnPage(page, 2).first()).toBeVisible();
  const folded = await pagesAgainstPane(page, [1, 2]);
  expect(folded.overflows).toBeLessThanOrEqual(0);
  expect(folded.fillsHeight).toBeGreaterThan(0.98);
});

test("spends the pane's height on the page rather than on a band under it", async ({ page }) => {
  // A window whose page pane is close to as narrow as the page's own
  // proportions, which is where the fit used to run out of width with height to
  // spare. The row of page controls stood in that spare height; with the row
  // gone it read as a hole, and it is height the reader could have been given.
  await page.setViewportSize({ width: 1512, height: 982 });
  await openTestBook(page);

  const { page: drawn, pane, wastedUnderPage } = await drawnPageAndPane(page);

  // The pane really is the tight one this test is about: the page is within a
  // hair of using all of its width (measured at ~9px of 645). Without pinning
  // the width, a pane that had grown wide enough to have no spare height would
  // satisfy the rest of this test while testing nothing.
  expect(pane.width - drawn.width).toBeLessThan(16);
  // ...and it is not clipped. Fitting to a height it matches exactly lands
  // within a rounding of the width, so a whole pixel over is the line.
  expect(drawn.width - pane.width).toBeLessThan(1);

  // Nothing of the pane's height is left over beyond its own gutter
  expect(wastedUnderPage).toBeLessThan(1);
});

/**
 * The pages named, measured against each other and against the pane they share.
 *
 * `fillsHeight` is the *shortest* page's share of the pane's height: a second
 * page is only worth having if it costs the first one nothing and is not shrunk
 * itself, so the page that came off worst is the one worth asking about.
 * `laidOutRightOf` is how far the second page's left edge sits past the first
 * page's right edge — the reader is promised a spread, and neither a stack nor
 * a swapped pair would be one, so being beside each other in this order is part
 * of what is measured.
 */
async function pagesAgainstPane(page: Page, upNow: [number, number]) {
  await settledCanvasWidth(page);

  return page
    .locator("canvas.block")
    .first()
    .evaluate((first, up) => {
      let pane = first.parentElement;
      while (pane && getComputedStyle(pane).overflowY !== "auto") pane = pane.parentElement;
      if (!pane) throw new Error("the scrolling pane around the page was not found");

      const style = getComputedStyle(pane);
      const paneWidth =
        pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const paneHeight =
        pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);

      const boxes = up.map((pageNumber) => {
        const canvas = pane.querySelector(`[data-page-container="${pageNumber}"] canvas.block`);
        if (!canvas) throw new Error(`page ${pageNumber} is not drawn`);
        return canvas.getBoundingClientRect();
      });
      const [left, right] = boxes;

      return {
        count: pane.querySelectorAll("canvas.block").length,
        overflows: Math.max(
          right.right - left.left - paneWidth,
          ...boxes.map((b) => b.height - paneHeight),
        ),
        fillsHeight: Math.min(...boxes.map((b) => b.height)) / paneHeight,
        laidOutRightOf: right.left - left.right,
        topsApart: Math.abs(right.top - left.top),
      };
    }, upNow);
}

test("puts a second page up once the pane has room for it, and takes it back when it has not", async ({
  page,
}) => {
  // Both panels beside the page leave room for one page at this window size
  await openTestBook(page);
  await expect(page.locator("canvas.block")).toHaveCount(1);

  await page.getByRole("button", { name: "チャットを隠す" }).click();

  await expect(drawnPage(page, 1).first()).toBeVisible();
  await expect(drawnPage(page, 2).first()).toBeVisible();
  const spread = await pagesAgainstPane(page, [1, 2]);
  expect(spread.count).toBe(2);
  // Page 2 is beside page 1 rather than under it, and in that order
  expect(spread.laidOutRightOf).toBeGreaterThan(0);
  expect(spread.topsApart).toBeLessThan(1);
  // Neither page is clipped, and neither has been shrunk to make room for the
  // other: the shorter of the two is still as tall as the pane, which is what
  // one page alone would have been.
  expect(spread.overflows).toBeLessThanOrEqual(0);
  expect(spread.fillsHeight).toBeGreaterThan(0.98);

  await page.getByRole("button", { name: "チャットを表示" }).click();

  await expect(page.locator("canvas.block")).toHaveCount(1);
  await expect(drawnPage(page, 1).first()).toBeVisible();
});

test("turns both pages of a spread at once, and stops at the last one", async ({ page }) => {
  const pdfId = await openTestBook(page);
  await foldChatPane(page, pdfId);
  // The spread before the last one: with twelve pages that is [9|10]
  await page.goto(`/books/${pdfId}?page=${PAGE_COUNT - 3}`);
  await expect(drawnPage(page, PAGE_COUNT - 3).first()).toBeVisible({ timeout: 60000 });
  await expect(drawnPage(page, PAGE_COUNT - 2).first()).toBeVisible();

  await page.keyboard.press("l");

  // Both pages change together: turning one at a time would show the right hand
  // page of the last spread again on the left of the next.
  await expect(drawnPage(page, PAGE_COUNT - 1).first()).toBeVisible();
  await expect(drawnPage(page, PAGE_COUNT).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${PAGE_COUNT - 1}(&|$)`));

  await page.keyboard.press("l");
  await page.keyboard.press("h");

  // The end of the book: the second turn had nowhere to land, so stepping back
  // from it goes to the spread before the last one. Read from where the step
  // back arrives rather than from the last spread still being up, which was
  // already true before the key was pressed: had the turn moved, the step back
  // would land on 10 instead.
  await expect(page).toHaveURL(new RegExp(`[?&]page=${PAGE_COUNT - 3}(&|$)`));
  await expect(drawnPage(page, PAGE_COUNT - 3).first()).toBeVisible();
  await expect(drawnPage(page, PAGE_COUNT - 2).first()).toBeVisible();
});

/**
 * Whether every mark drawn on the passage lands inside the named page's box.
 *
 * The rectangles are measured against one page element and drawn inside it, so
 * a passage measured against the wrong page of a spread reaches a page's width
 * past the edge of the one it is drawn in. False when nothing is marked at all,
 * so this cannot be satisfied by an empty selection.
 */
async function marksLandInside(page: Page, pageNumber: number): Promise<boolean> {
  return page.evaluate((n) => {
    const box = document.querySelector(`[data-page-container="${n}"]`)!.getBoundingClientRect();
    const marks = Array.from(document.querySelectorAll(".pendingSelection"));
    return (
      marks.length > 0 &&
      marks.every((mark) => {
        const rect = mark.getBoundingClientRect();
        return rect.left >= box.left - 1 && rect.right <= box.right + 1;
      })
    );
  }, pageNumber);
}

/** Drag from one end of a drawn line of text to the other. */
async function dragAlong(page: Page, from: Locator, to: Locator) {
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  // Pressing down inside the span rather than beside it: the text layer's spans
  // are absolutely positioned, and a press in the gap around one starts no
  // selection at all.
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("marks a passage taken from the right page of a spread on that page", async ({ page }) => {
  const pdfId = await openTestBook(page);
  await foldChatPane(page, pdfId);
  await page.goto(`/books/${pdfId}?page=4`);
  await expect(drawnPage(page, 5).first()).toBeVisible({ timeout: 60000 });

  await dragAlong(page, drawnPage(page, 5).first(), drawnPage(page, 5).first());

  // The rectangles are measured against the page the passage was dragged on, so
  // one taken from the right page belongs to the right page's own overlay —
  // measured against the left one it would be drawn a page's width out.
  await expect(page.locator('[data-page-container="5"] .pendingSelection').first()).toBeVisible({
    timeout: 10000,
  });
  expect(await marksLandInside(page, 5)).toBe(true);
  await expect(page.locator('[data-page-container="4"] .pendingSelection')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });
});

test("keeps a drag made right to left on the page it was begun on", async ({ page }) => {
  // The page a passage belongs to is where the reader pressed down, not where
  // the range begins: a range is always in document order, so this drag hands
  // the viewer one that starts on the page the reader ended on.
  const pdfId = await openTestBook(page);
  await foldChatPane(page, pdfId);
  await page.goto(`/books/${pdfId}?page=4`);
  await expect(drawnPage(page, 5).first()).toBeVisible({ timeout: 60000 });

  await dragAlong(page, drawnPage(page, 5).nth(2), drawnPage(page, 4).first());

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain(pageText(4).body[0]);

  await expect(page.locator('[data-page-container="5"] .pendingSelection').first()).toBeVisible({
    timeout: 10000,
  });
  expect(await marksLandInside(page, 5)).toBe(true);
  await expect(page.locator('[data-page-container="4"] .pendingSelection')).toHaveCount(0);
});

test("keeps a drag that runs on to the next page to the page it began on", async ({ page }) => {
  const pdfId = await openTestBook(page);
  await foldChatPane(page, pdfId);
  await page.goto(`/books/${pdfId}?page=4`);
  await expect(drawnPage(page, 5).first()).toBeVisible({ timeout: 60000 });

  // From a line of the left page across the gap and into the right one
  await dragAlong(page, drawnPage(page, 4).first(), drawnPage(page, 5).nth(2));

  // The drag really did run on to the second page. Without this the rest would
  // pass just as well on a selection that never left the first one.
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain(pageText(5).body[0]);

  await expect(page.locator('[data-page-container="4"] .pendingSelection').first()).toBeVisible({
    timeout: 10000,
  });
  // A highlight is stored in one page's pixels, so the part on the second page
  // has nowhere to go: it is dropped rather than drawn past the first page's
  // own edge, which is where measuring it against the left page would put it.
  expect(await marksLandInside(page, 4)).toBe(true);
  await expect(page.locator('[data-page-container="5"] .pendingSelection')).toHaveCount(0);
});

/**
 * Pinch out over the middle of the page, as a trackpad reports it: a wheel
 * event with ctrlKey set.
 */
async function pinchOut(page: Page, times = 1) {
  const box = (await page.locator("canvas.block").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
}

/** The same gesture the other way, which takes the zoom down to MIN_ZOOM. */
async function pinchIn(page: Page, times = 1) {
  const box = (await page.locator("canvas.block").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
}

test("a pinch zooms the page in, and the book opens at that zoom next time", async ({ page }) => {
  await openTestBook(page);
  const fitted = await settledCanvasWidth(page);

  await pinchOut(page);

  const zoomed = await settledCanvasWidth(page);
  expect(zoomed).toBeGreaterThan(fitted * 1.4);

  // The reader's zoom belongs to the book, not to the session: the store the
  // reader holds it in is thrown away on every trip through the shelf.
  await page.reload();
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });

  expect(await settledCanvasWidth(page)).toBeGreaterThan(fitted * 1.4);
});

test("a passage can still be selected once the page is zoomed in", async ({ page }) => {
  await openTestBook(page);
  await goToPageWithText(page);
  const fitted = await settledCanvasWidth(page);
  const lineBefore = (await page.locator(".textLayer span").first().boundingBox())!;

  await pinchOut(page);

  const zoomed = await settledCanvasWidth(page);
  // Without this the rest would be a selection test at the fit scale again
  expect(zoomed).toBeGreaterThan(fitted * 1.4);

  // The spans are laid out from `--scale-factor`, which is a value of its own:
  // left at the fit scale the words would stay where they were while the canvas
  // grew under them, and the drag below would land on the wrong text.
  const line = page.locator(".textLayer span").first();
  const box = (await line.boundingBox())!;
  expect(box.width / lineBefore.width).toBeCloseTo(zoomed / fitted, 1);
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });

  // The mark is drawn over the line that was dragged, not where an unzoomed
  // text layer would have put it
  const marks = page.locator(".pendingSelection");
  await expect(marks.first()).toBeVisible();
  expect(await lowestMark(marks)).toBeLessThan(box.y + box.height + 20);
});

test("puts a second page up once the reader shrinks the page enough for one", async ({ page }) => {
  // Both panels are beside the page at this window size, which leaves room for
  // one page at the fit scale.
  await openTestBook(page);
  await expect(page.locator("canvas.block")).toHaveCount(1);
  const fitted = await settledCanvasWidth(page);

  await pinchIn(page);

  await expect(page.locator("canvas.block")).toHaveCount(2);
  await expect(drawnPage(page, 1).first()).toBeVisible();
  await expect(drawnPage(page, 2).first()).toBeVisible();

  // Each page is the size it would be alone at this zoom, which is what made
  // room for the second one. Fitting them to half the pane instead would draw
  // them smaller still — here the half is narrower than the page is tall, so
  // the width would take over and shrink both well past the reader's zoom.
  const shrunk = await settledCanvasWidth(page);
  expect(shrunk / fitted).toBeCloseTo(0.5, 1);
  const spread = await pagesAgainstPane(page, [1, 2]);
  expect(spread.overflows).toBeLessThanOrEqual(0);
  expect(spread.laidOutRightOf).toBeGreaterThan(0);
});

test("takes the second page back when the reader zooms in past what the pane holds twice", async ({
  page,
}) => {
  await openTestBook(page);
  await page.getByRole("button", { name: "チャットを隠す" }).click();
  await expect(page.locator("canvas.block")).toHaveCount(2);
  const beside = await settledCanvasWidth(page);

  await pinchOut(page, 2);

  // The page the reader enlarged is the one they are reading, so the second one
  // gives way rather than both being squeezed back to fitting.
  await expect(page.locator("canvas.block")).toHaveCount(1);
  await expect(drawnPage(page, 1).first()).toBeVisible();
  // The page that stayed is larger than it was beside the other, which is what
  // took the room the second one had: a page that vanished while the first was
  // drawn at its old size would be some other fault.
  expect(await settledCanvasWidth(page)).toBeGreaterThan(beside * 1.4);
});

/** Which page is drawn, read off the label its spans carry. */
async function drawnPageNumber(page: Page): Promise<number> {
  const label = await page.locator(".textLayer span").first().getAttribute("data-page-number");
  // Without this the caller would be told a page number of 0 and left to work
  // out that the text layer was what was missing.
  if (label === null) throw new Error("the drawn page carries no page number");
  return Number(label);
}

test("reloading resumes on the page being read", async ({ page }) => {
  await openTestBook(page);
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(drawnPage(page, 3).first()).toBeVisible();

  // The page being read is in the URL, so it survives a reload
  await expect(page).toHaveURL(/[?&]page=3/);
  await page.reload();

  await expect(drawnPage(page, 3).first()).toBeVisible({ timeout: 60000 });
});

test("a book put down on one page is picked up there from the shelf", async ({ page }) => {
  // The place is kept on the server, which is what lets another device open the
  // book where this one left it. The shelf is how that arrives: its link
  // carries no page, so nothing but the saved place says where to open.
  const pdfId = await openTestBook(page);
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(drawnPage(page, 3).first()).toBeVisible();

  // Leaving for the shelf unmounts the reader, which sends the turn still being
  // waited on rather than dropping it
  await page.getByRole("link", { name: "← 本棚" }).click();
  await expect
    .poll(
      async () => {
        const book = (await (await page.request.get(`/api/pdf/${pdfId}`)).json()) as {
          readingState: { page: number } | null;
        };
        return book.readingState?.page ?? null;
      },
      { timeout: 15000 },
    )
    .toBe(3);

  // Loaded afresh, so nothing this tab remembered can be what opens the book
  await page.goto("/");
  await page.getByRole("button", { name: FIXTURE_TITLE }).first().click();

  await expect(drawnPage(page, 3).first()).toBeVisible({ timeout: 60000 });
  await expect(page).toHaveURL(/[?&]page=3/);
});

test("a browser text-fragment link opens the page holding the passage", async ({ page }) => {
  const pdfId = await openTestBook(page);
  await goToPageWithText(page);
  const expectedPage = await drawnPageNumber(page);
  expect(expectedPage).toBeGreaterThan(1);

  // Take a passage long enough to appear on exactly one page, the way Chrome's
  // "Copy link to highlight" would capture a selection. Running headers repeat
  // across pages, so a short one could resolve to an earlier page.
  const spans = await page.locator(".textLayer span").allTextContents();
  let passage = "";
  for (const span of spans) {
    passage = `${passage}${span}`.trim();
    if (passage.length >= 40) break;
  }
  expect(passage.length).toBeGreaterThanOrEqual(40);

  await page.goto(`/books/${pdfId}#:~:text=${encodeURIComponent(passage)}`);

  await expect(drawnPage(page, expectedPage).first()).toBeVisible({
    timeout: 60000,
  });
});

test("dragging over the page selects text and offers to ask about it", async ({ page }) => {
  await openTestBook(page);
  await goToPageWithText(page);

  // Nothing may cover the page: the text layer has to receive the pointer.
  // Asked as "what does the pointer reach" rather than "which classes is it
  // not", so a renamed overlay class cannot quietly empty the check.
  const canvas = page.locator("canvas.block").first();
  const canvasBox = (await canvas.boundingBox())!;
  const topmost = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return "nothing at all";
      return el.closest(".textLayer") ? "the text layer" : `${el.tagName.toLowerCase()} over it`;
    },
    [canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2] as const,
  );
  expect(topmost).toBe("the text layer");

  // Drag across a line of text the way a user would
  const line = page.locator(".textLayer span").first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);

  // The selection opens the question popover
  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });
});

test("the passage is marked while it is still being dragged", async ({ page }) => {
  await openTestBook(page);
  await goToPageWithText(page);

  const line = page.locator(".textLayer span").first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });

  // Still holding the button: the app draws the selection itself, because the
  // browser's own colour doubles up where pdf.js' spans overlap
  await expect(page.locator(".pendingSelection").first()).toBeVisible();

  await page.mouse.up();
});

test("the selected passage stays marked while the question is written", async ({ page }) => {
  await openTestBook(page);
  await goToPageWithText(page);

  const line = page.locator(".textLayer span").first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });

  // Focusing the question box clears the browser's own selection, so without a
  // mark of our own the reader loses track of what the question is about
  const marks = page.locator(".pendingSelection");
  await expect(marks.first()).toBeVisible();

  const markBox = (await marks.first().boundingBox())!;
  expect(markBox.width).toBeGreaterThan(0);
  expect(markBox.height).toBeGreaterThan(0);
});

/** How far down the page the drawn selection reaches. */
async function lowestMark(marks: Locator): Promise<number> {
  return marks.evaluateAll((nodes) =>
    Math.max(...nodes.map((n) => n.getBoundingClientRect().bottom)),
  );
}

test("overshooting a line does not select the rest of the page", async ({ page }) => {
  // One pixel wider than the default window, to keep the page off a sub-pixel
  // position headless Chromium cannot drag a selection across.
  //
  // Where the page lands horizontally follows the width of the pane, and at
  // exactly x.734375 headless Chromium answers every move of a held button
  // with a fresh caret instead of extending the selection, so a drag selects
  // nothing at all. Nothing here is at fault: the same offset, forced by hand,
  // selects normally under `--headed`, and reproduces on `main` — the widths
  // this reader happens to use are the only thing that decides whether a run
  // sits on it. Left unpinned, this test would blink in and out with every
  // change to the layout around the page.
  await page.setViewportSize({ width: 1281, height: 720 });
  const pdfId = await openTestBook(page);
  // A page whose body text sits above a figure, which is where painting order
  // and reading order come apart
  await page.goto(`/books/${pdfId}?page=${FIGURE_PAGE}`);
  await expect(drawnPage(page, FIGURE_PAGE).first()).toBeVisible({
    timeout: 60000,
  });
  // The whole text layer, not just the spans that arrived first: the drag below
  // is measured from where the spans are.
  await settledSpanCount(page);

  // pdf.js lays spans out in painting order, not reading order, so a drag that
  // ends past the end of a line can run on to a figure's labels further down
  const drag = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.block")!.getBoundingClientRect();
    // The page can be taller than the pane, so only work with what is on screen
    const onScreen = Array.from(document.querySelectorAll(".textLayer span"))
      .map((s) => s.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.top > Math.max(canvas.top, 80) && r.bottom < innerHeight - 80)
      .sort((a, b) => a.top - b.top || a.left - b.left);

    const first = onScreen[0];
    const nextLine = onScreen.find((r) => r.top > first.bottom - first.height / 2);
    if (!first || !nextLine) throw new Error("no two lines of text are visible");

    return {
      startX: first.left + 4,
      startY: first.top + first.height / 2,
      // Release in the empty margin to the right of the second line
      endX: canvas.right - 6,
      endY: nextLine.top + nextLine.height / 2,
      lineBottom: nextLine.bottom,
    };
  });

  const marks = page.locator(".pendingSelection");

  await page.mouse.move(drag.startX, drag.startY);
  await page.mouse.down();
  await page.mouse.move(drag.endX, drag.endY, { steps: 20 });

  // Mid-drag: the guard parks the overshoot inside a page-sized element, so
  // check the mark does not inherit its size before the button is released
  await expect(marks.first()).toBeVisible();
  expect(await lowestMark(marks)).toBeLessThan(drag.lineBottom + 20);

  await page.mouse.up();

  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });

  // The drag covered two lines, so nothing should be marked below the second
  // one. Anything further down means the selection ran off through the DOM.
  await expect(marks.first()).toBeVisible();
  expect(await lowestMark(marks)).toBeLessThan(drag.lineBottom + 20);
});

test("the marked passage stays put once the question box has taken the focus", async ({ page }) => {
  // Opening the box moves the selection into its field, and that move is
  // announced like any other. The wait for the selection to settle starts over
  // on it, so the passage is measured a second time a quarter of a second after
  // the box appears — with the reader's selection no longer on the page at all.
  //
  // That second measurement used to answer with every line of the page, because
  // cutting a range to the page it belongs to stretched one that had left the
  // page from the first line to the last. The answer replaced the passage the
  // reader chose, so the mark spread over the whole page just after the box
  // came up, and the highlight would have been stored that way.
  const pdfId = await openTestBook(page);
  await page.goto(`/books/${pdfId}?page=${FIGURE_PAGE}`);
  await expect(drawnPage(page, FIGURE_PAGE).first()).toBeVisible({ timeout: 60000 });

  const line = drawnPage(page, FIGURE_PAGE).first();
  const lineBox = (await line.boundingBox())!;
  await dragAlong(page, line, line);

  const marks = page.locator(".pendingSelection");
  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });
  const chosen = await lowestMark(marks);

  // Long enough for a second settle to have come and gone
  await page.waitForTimeout(SELECTION_SETTLE_MS * 4);

  await expect(marks.first()).toBeVisible();
  // Held against the line that was dragged, not against what was measured a
  // moment ago: a reading taken late enough to catch the spread would make the
  // spread its own expected value and pass.
  expect(await lowestMark(marks)).toBeLessThan(lineBox.y + lineBox.height + 20);
  expect(await lowestMark(marks)).toBe(chosen);
});

test("the reader fits the viewport without scrolling the page", async ({ page }) => {
  await openTestBook(page);
  // Rendering a text layer is what appends pdf.js' measurement canvas to <body>
  await goToPageWithText(page);

  // The reader owns the whole viewport; only its inner panes scroll. A taller
  // document means stray content is pushing the page down.
  const { scrollHeight, clientHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight);

  // pdf.js appends a measurement canvas to <body>. Its size is only zero part
  // of the time, so assert it is kept out of layout entirely rather than
  // relying on the box it happens to have right now.
  const measurementCanvasDisplay = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.hiddenCanvasElement");
    return canvas ? getComputedStyle(canvas).display : "absent";
  });
  expect(["absent", "none"]).toContain(measurementCanvasDisplay);
});

test("the outline lists chapters and jumps to the selected one", async ({ page }) => {
  await openTestBook(page);

  const [firstChapter] = OUTLINE;
  const [firstSection, secondSection] = firstChapter.children;
  // Each entry reads as its title followed by the page it resolved to
  const entryName = (entry: { title: string; page: number }) => `${entry.title} ${entry.page}`;

  const outline = page.getByRole("navigation", { name: "目次" });
  const chapter = outline.getByRole("button", { name: entryName(firstChapter), exact: true });
  await expect(chapter).toBeVisible({ timeout: 30000 });

  // Nested sections are listed too
  await expect(
    outline.getByRole("button", { name: entryName(firstSection), exact: true }),
  ).toBeVisible();

  await chapter.click();
  await expect(drawnPage(page, firstChapter.page).first()).toBeVisible({
    timeout: 10000,
  });

  // Nested entries resolve to their own page
  await outline.getByRole("button", { name: entryName(secondSection), exact: true }).click();
  await expect(drawnPage(page, secondSection.page).first()).toBeVisible({
    timeout: 10000,
  });
});

test("a folded outline stays folded through a reload", async ({ page }) => {
  // The outline is the book's own answer rather than part of the URL, so what
  // brings it back folded is the save landing before the reload.
  await openTestBook(page);
  const outline = page.getByRole("navigation", { name: "目次" });
  await expect(outline).toBeVisible();

  const saved = placeSaved(page);
  await page.getByRole("button", { name: "目次を隠す" }).click();
  await saved;

  await page.reload();

  // The book being drawn is what says the reader is back, rather than the
  // outline being missing from a page that has not arrived at all
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "目次を表示" })).toBeVisible();
  await expect(outline).toBeHidden();
});

test("both folded panels come back when the book is opened from the shelf", async ({ page }) => {
  // What the reader complained about: the outline came back open every time the
  // book was opened on a laptop, however often they folded it away.
  const pdfId = await openTestBook(page);
  const outline = page.getByRole("navigation", { name: "目次" });
  await expect(outline).toBeVisible();

  await page.getByRole("button", { name: "目次を隠す" }).click();
  const saved = placeSaved(page);
  await page.getByRole("button", { name: "チャットを隠す" }).click();
  await saved;
  await expect
    .poll(
      async () => {
        const book = (await (await page.request.get(`/api/pdf/${pdfId}`)).json()) as {
          readingState: StoredPlace;
        };
        return book.readingState?.chatPanelOpen ?? null;
      },
      { timeout: 15000 },
    )
    .toBe(false);

  // Loaded afresh through the shelf, whose link carries no page and nothing
  // about the panels: what folds them is the book's own answer
  await page.goto("/");
  await page.getByRole("button", { name: FIXTURE_TITLE }).first().click();

  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "目次を表示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "チャットを表示" })).toBeVisible();
  await expect(outline).toBeHidden();

  // And the book still says so afterwards: landing on a restored place used to
  // save the width's own defaults back over it, which is the bug in miniature
  await page.waitForTimeout(SAVE_SETTLE_MS);
  const after = (await (await page.request.get(`/api/pdf/${pdfId}`)).json()) as {
    readingState: StoredPlace;
  };
  expect(after.readingState?.outlineOpen).toBe(false);
  expect(after.readingState?.chatPanelOpen).toBe(false);
});

test("an old link naming the panels no longer has a say over them", async ({ page }) => {
  // Links written when the panels were in the address bar are still in browser
  // histories and bookmarks. Obeying one is what used to bring the outline back
  // open — and then save that over the reader's own choice.
  const pdfId = await openTestBook(page);
  const saved = placeSaved(page);
  await page.getByRole("button", { name: "目次を隠す" }).click();
  await saved;
  // The chat pane goes the other way, so the link below contradicts the book on
  // both counts: saying open where it is folded, and closed where it is up
  await foldChatPane(page, pdfId);

  await page.goto(`/books/${pdfId}?page=1&outline=open&panel=open`);
  await expect(drawnPage(page, 1).first()).toBeVisible({ timeout: 60000 });

  // Both come from the book now, and the book disagrees with the link on each
  await expect(page.getByRole("button", { name: "目次を表示" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "目次" })).toBeHidden();
  await expect(page.getByRole("button", { name: "チャットを表示" })).toBeVisible();
  // And the parameters are swept out rather than left to be shared onwards
  await expect(page).toHaveURL(/\?page=1$/);
});

test("vim keys turn pages, scroll, and toggle the outline by default", async ({ page }) => {
  await openTestBook(page);
  const outline = page.getByRole("navigation", { name: "目次" });
  await expect(outline).toBeVisible();

  await page.keyboard.press("l");
  await expect(drawnPage(page, 2).first()).toBeVisible();

  await page.keyboard.press("h");
  await expect(drawnPage(page, 1).first()).toBeVisible();

  // j/k move within the page instead of turning it. What says they did not turn
  // it is the `l` further down landing on 2: page 1 still being drawn is only
  // the page that was already there.
  const restingTop = await pageScrollTop(page);
  expect(restingTop).toBe(0);

  await page.keyboard.press("j");
  await expect.poll(() => pageScrollTop(page)).toBeGreaterThan(0);
  await expect(drawnPage(page, 1).first()).toBeVisible();

  await page.keyboard.press("k");
  await expect.poll(() => pageScrollTop(page)).toBe(0);

  // A page turn starts the next page at its top, wherever the last one was left
  await page.keyboard.press("j");
  await expect.poll(() => pageScrollTop(page)).toBeGreaterThan(0);
  await page.keyboard.press("l");
  await expect(drawnPage(page, 2).first()).toBeVisible();
  await expect.poll(() => pageScrollTop(page)).toBe(0);

  await page.keyboard.press("t");
  await expect(outline).toBeHidden();
  await page.keyboard.press("t");
  await expect(outline).toBeVisible();

  // gg / G jump to the ends of the book
  await page.keyboard.press("Shift+G");
  await expect(drawnPage(page, PAGE_COUNT).first()).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(drawnPage(page, 1).first()).toBeVisible();
});

test("switching to emacs in settings changes the bindings and survives a reload", async ({
  page,
}) => {
  await openTestBook(page);

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("radio", { name: "Emacs" }).check();
  await page.keyboard.press("Escape");

  // The vim binding is gone...
  await page.keyboard.press("l");
  await expect(drawnPage(page, 1).first()).toBeVisible();

  // ...and the emacs one works. Landing on 2 is also what says `l` above did
  // nothing: a turn that had counted would make this one land on 3. Page 1
  // being drawn is on its own no proof, since it is what was already there.
  await page.keyboard.press("Control+f");
  await expect(drawnPage(page, 2).first()).toBeVisible();

  // C-c t is a two-stroke sequence
  const outline = page.getByRole("navigation", { name: "目次" });
  await page.keyboard.press("Control+c");
  await page.keyboard.press("t");
  await expect(outline).toBeHidden();

  await page.reload();
  // The reload resumes on the page that was being read, not back at the cover
  await expect(drawnPage(page, 2).first()).toBeVisible({ timeout: 60000 });

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Emacs" })).toBeChecked();
});

test("logging out takes the session back and puts the password box up", async ({ page }) => {
  // The one way out, and the only thing between a borrowed laptop and the
  // books. It lives in the settings menu because that is the one control on
  // screen in both layouts.
  await openTestBook(page);

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("button", { name: "ログアウト" }).click();

  await expect(page.getByLabel("パスワード")).toBeVisible();
  // Gone at the server too, rather than merely hidden behind the box: the
  // cookie the browser still had would otherwise open every book again.
  const refused = await page.request.get("/api/pdfs", { failOnStatusCode: false });
  expect(refused.status()).toBe(401);
});

test("typing in the chat box does not trigger shortcuts", async ({ page }) => {
  // Activate a selection so the chat input renders
  const pdfId = await openTestBook(page);
  await page.request.post(`/api/pdf/${pdfId}/selections`, {
    data: {
      selectedText: "検証用のハイライト",
      pageNumber: 1,
      positionData: {
        startIndex: 0,
        endIndex: 1,
        rects: [{ x: 40, y: 40, width: 160, height: 24 }],
      },
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "ハイライトのチャットを開く" }).click();

  const restingTop = await pageScrollTop(page);
  expect(restingTop).toBe(0);

  const input = page.getByPlaceholder("質問を入力...");
  await input.click();
  await input.fill("");

  // Check the scroll before typing k: k would undo j's scroll, leaving the pane
  // back at 0 and the assertion unable to tell a stray scroll from none at all.
  await page.keyboard.type("hlj");
  expect(await pageScrollTop(page)).toBe(0);

  await page.keyboard.type("kt");

  // Every binding stays inert: no page turn (h/l), no scroll (j/k), no outline (t)
  await expect(input).toHaveValue("hljkt");
  await expect(drawnPage(page, 1).first()).toBeVisible();
  expect(await pageScrollTop(page)).toBe(0);
  await expect(page.getByRole("navigation", { name: "目次" })).toBeVisible();

  // Page 1 is the page that was already there, so it says little by itself.
  // Leaving the box and turning once does: had a turn gone through while the
  // question was being typed, this one would land on 3. The click is in the
  // middle of the pane, which is neither of the bands that turn a page.
  const pane = page.locator("main .overflow-auto").first();
  const box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("l");
  await expect(drawnPage(page, 2).first()).toBeVisible();
});

test("the book title stays in the reader header instead of the chat panel", async ({ page }) => {
  const pdfId = await openTestBook(page);
  await page.request.post(`/api/pdf/${pdfId}/selections`, {
    data: {
      selectedText: "検証用のハイライト",
      pageNumber: 1,
      positionData: {
        startIndex: 0,
        endIndex: 1,
        rects: [{ x: 40, y: 40, width: 160, height: 24 }],
      },
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "ハイライトのチャットを開く" }).click();

  await expect(page.getByRole("banner").getByText(FIXTURE_FILE_NAME)).toBeVisible();

  // The chat panel is for the conversation; repeating the title there only ate
  // vertical space
  const chatPanel = page.locator("main > div").last();
  await expect(chatPanel.getByPlaceholder("質問を入力...")).toBeVisible();
  await expect(chatPanel.getByText(FIXTURE_FILE_NAME)).toBeHidden();
});

test("the chat panel lists the highlights, opens one, and comes back to the list", async ({
  page,
}) => {
  const pdfId = await openTestBook(page);
  // Lines that really are on those pages, so the panel and the page's text
  // layer show the same words and the scoping below is doing something
  const firstPassage = pageText(2).body[0];
  const laterPassage = pageText(3).body[0];
  for (const [passage, pageNumber] of [
    [firstPassage, 2],
    [laterPassage, 3],
  ] as const) {
    await page.request.post(`/api/pdf/${pdfId}/selections`, {
      data: {
        selectedText: passage,
        pageNumber,
        positionData: {
          startIndex: 0,
          endIndex: passage.length,
          rects: [{ x: 40, y: 40, width: 160, height: 24 }],
        },
      },
    });
  }
  await page.reload();

  // Scope to the panel: these passages can also appear in the page's text layer
  const chatPanel = page.locator("main > div").last();

  // No conversation is open, so the panel is the way into the past ones
  await expect(chatPanel.getByText("ハイライト 2件")).toBeVisible({ timeout: 60000 });
  await expect(chatPanel.getByText(firstPassage, { exact: true })).toBeVisible();

  // Opening a highlight of another page brings the viewer along
  await chatPanel.getByText(laterPassage, { exact: true }).click();
  await expect(chatPanel.getByPlaceholder("質問を入力...")).toBeVisible();
  await expect(drawnPage(page, 3).first()).toBeVisible();

  await chatPanel.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(chatPanel.getByText("ハイライト 2件")).toBeVisible();
  await expect(chatPanel.getByPlaceholder("質問を入力...")).toBeHidden();
});

test("searching the list narrows it to what the server matched", async ({ page }) => {
  // The chats are searched too, but only the server can see them: an answer
  // cannot be saved from here without a live model, so the passage is what this
  // one types. What it does prove is that the box reaches the server at all —
  // `test/worker/pdf.test.ts` covers the chat half of the same query.
  const pdfId = await openTestBook(page);
  const wanted = pageText(2).body[0];
  const other = pageText(3).body[0];
  for (const [passage, pageNumber] of [
    [wanted, 2],
    [other, 3],
  ] as const) {
    await page.request.post(`/api/pdf/${pdfId}/selections`, {
      data: {
        selectedText: passage,
        pageNumber,
        positionData: {
          startIndex: 0,
          endIndex: passage.length,
          rects: [{ x: 40, y: 40, width: 160, height: 24 }],
        },
      },
    });
  }
  await page.reload();

  const chatPanel = page.locator("main > div").last();
  await expect(chatPanel.getByText("ハイライト 2件", { exact: true })).toBeVisible({
    timeout: 60000,
  });

  // Typing is not searching: the list stays whole until the button is pressed
  await chatPanel.getByLabel("ハイライトを検索").fill(wanted.slice(0, 6));
  await expect(chatPanel.getByText("ハイライト 2件", { exact: true })).toBeVisible();

  await chatPanel.getByRole("button", { name: "検索" }).click();

  await expect(chatPanel.getByText("ハイライト 2件中 1件", { exact: true })).toBeVisible();
  await expect(chatPanel.getByText(wanted, { exact: true })).toBeVisible();
  await expect(chatPanel.getByText(other, { exact: true })).toBeHidden();

  // Emptying the box and searching again gives the whole list back
  await chatPanel.getByLabel("ハイライトを検索").fill("");
  await chatPanel.getByRole("button", { name: "検索" }).click();
  await expect(chatPanel.getByText("ハイライト 2件", { exact: true })).toBeVisible();
  await expect(chatPanel.getByText(other, { exact: true })).toBeVisible();

  // Enter runs it too, so the box can be used without reaching for the mouse
  await chatPanel.getByLabel("ハイライトを検索").fill(other.slice(0, 6));
  await chatPanel.getByLabel("ハイライトを検索").press("Enter");
  await expect(chatPanel.getByText("ハイライト 2件中 1件", { exact: true })).toBeVisible();
  await expect(chatPanel.getByText(other, { exact: true })).toBeVisible();
});

test("a highlight deleted from the list stays gone after a reload", async ({ page }) => {
  const pdfId = await openTestBook(page);
  const doomedPassage = pageText(2).body[0];
  const keptPassage = pageText(3).body[0];
  for (const [passage, pageNumber] of [
    [doomedPassage, 2],
    [keptPassage, 3],
  ] as const) {
    await page.request.post(`/api/pdf/${pdfId}/selections`, {
      data: {
        selectedText: passage,
        pageNumber,
        positionData: {
          startIndex: 0,
          endIndex: passage.length,
          rects: [{ x: 40, y: 40, width: 160, height: 24 }],
        },
      },
    });
  }
  await page.reload();

  const chatPanel = page.locator("main > div").last();
  await expect(chatPanel.getByText("ハイライト 2件", { exact: true })).toBeVisible({
    timeout: 60000,
  });

  const doomedRow = chatPanel.locator("li").filter({ hasText: doomedPassage });
  await doomedRow.getByRole("button", { name: /を削除$/ }).click();
  await expect(
    page.getByText("このハイライトを削除しますか？このハイライトのチャット履歴も削除されます。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "削除する" }).click();

  await expect(chatPanel.getByText("ハイライト 1件", { exact: true })).toBeVisible();
  await expect(chatPanel.getByText(doomedPassage, { exact: true })).toBeHidden();

  // The server is what has to have dropped it: a list that only looks right
  // until the next read would pass everything above.
  await page.reload();
  await expect(chatPanel.getByText("ハイライト 1件", { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(chatPanel.getByText(keptPassage, { exact: true })).toBeVisible();
});

/**
 * Answer one question with a fixed stream, so the citation under test is the
 * test's own rather than whatever the model happens to write.
 *
 * Asking for real needs a DeepSeek key and ten seconds of generation, and would
 * make the assertions depend on the model quoting the book verbatim. The GET on
 * the same path — the chat's history — is left to the server.
 */
async function answerWith(page: Page, answer: string, citation: object) {
  await page.route("**/selections/*/chats", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();

    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body:
        `event: token\ndata: ${JSON.stringify({ content: answer })}\n\n` +
        `event: citation\ndata: ${JSON.stringify(citation)}\n\n` +
        `event: done\ndata: ${JSON.stringify({ messageId: "e2e-answer" })}\n\n`,
    });
  });
}

/**
 * How far the cited-passage mark sits from the line it quotes, and how much of
 * that line it covers. Both are measured on screen, so the numbers hold at any
 * zoom: a mark left over from another scale reads back as an offset.
 */
async function citedMarkPlacement(page: Page, quote: string) {
  return page.evaluate((quoted) => {
    const marked = document.querySelector(".citedPassage")?.getBoundingClientRect();
    const span = Array.from(document.querySelectorAll(".textLayer span")).find((s) => {
      const text = s.textContent?.trim() ?? "";
      return text.length > 4 && quoted.startsWith(text);
    });
    if (!marked || !span) return null;

    const box = span.getBoundingClientRect();
    return {
      left: Math.abs(marked.left - box.left),
      top: Math.abs(marked.top - box.top),
      widthRatio: marked.width / box.width,
    };
  }, quote);
}

/** The mark covers the quoted line, wherever the page is drawn and at whatever size. */
function expectMarkOnQuote(placement: Awaited<ReturnType<typeof citedMarkPlacement>>) {
  expect(placement).not.toBeNull();
  expect(placement!.left).toBeLessThan(6);
  expect(placement!.top).toBeLessThan(6);
  expect(placement!.widthRatio).toBeGreaterThan(0.8);
}

test("following a citation in the answer turns to its page and marks the quoted lines", async ({
  page,
}) => {
  const pdfId = await openTestBook(page);

  // The passage the answer will cite, taken from a page the reader is not on
  const citedPage = 4;
  const quote = pageText(citedPage).body[0];

  // A highlight to hang the conversation off, on the page the reader opens at,
  // so the citation is what moves the viewer
  await page.request.post(`/api/pdf/${pdfId}/selections`, {
    data: {
      selectedText: "検証用のハイライト",
      pageNumber: 1,
      positionData: {
        startIndex: 0,
        endIndex: 1,
        rects: [{ x: 40, y: 40, width: 160, height: 24 }],
      },
    },
  });

  await answerWith(page, `本書のこの箇所に書かれています[1]。`, {
    id: "1",
    type: "pdf",
    text: quote,
    pageNumber: citedPage,
  });

  await page.reload();
  await page.getByRole("button", { name: "ハイライトのチャットを開く" }).click({ timeout: 60000 });
  await page.getByPlaceholder("質問を入力...").fill("どこに書いてありますか");
  await page.getByRole("button", { name: "送信" }).click();

  // The source is reachable from the sentence that used it, with no list of
  // badges underneath the answer to look it up in
  const citationLink = page.getByRole("button", { name: "出典 [1] のページへ移動" });
  await expect(citationLink).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Sources:")).toBeHidden();

  await citationLink.click();
  await expect(drawnPage(page, citedPage).first()).toBeVisible({
    timeout: 60000,
  });

  // Turning to the page is only half of it: the quoted lines have to be marked,
  // over the words themselves rather than anywhere on the page
  const mark = page.locator(".citedPassage");
  await expect(mark.first()).toBeVisible({ timeout: 30000 });

  expectMarkOnQuote(await citedMarkPlacement(page, quote));

  // Zooming redraws the page at another size, and the mark is page pixels: kept
  // as they were measured, it would slide off the words it points at
  const fitted = await settledCanvasWidth(page);
  await pinchOut(page);
  const zoomed = await settledCanvasWidth(page);
  expect(zoomed).toBeGreaterThan(fitted * 1.4);

  await expect(mark.first()).toBeVisible();
  expectMarkOnQuote(await citedMarkPlacement(page, quote));

  // The mark stays while the passage is being read, and reading on ends it —
  // coming back to the page later is reading, not following the citation again
  await page.keyboard.press("l");
  await expect(drawnPage(page, citedPage + 1).first()).toBeVisible();
  await page.keyboard.press("h");

  // Wait for the page to be drawn again before looking: a mark that comes back
  // with it would otherwise be counted before it is there
  const citedPageSpans = page.locator(`.textLayer span[data-page-number="${citedPage}"]`);
  await expect.poll(() => citedPageSpans.count(), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(mark).toHaveCount(0);
  // Looked at twice, either side of the window a returning mark would arrive
  // in: a single look right after the redraw would pass on a mark that comes
  // back a frame later.
  await page.waitForTimeout(REDRAW_SETTLE_MS);
  await expect(mark).toHaveCount(0);
});

test("reloading brings back the folded panel and the chat that was open in it", async ({
  page,
}) => {
  const pdfId = await openTestBook(page);
  const passage = pageText(2).body[0];
  await page.request.post(`/api/pdf/${pdfId}/selections`, {
    data: {
      selectedText: passage,
      pageNumber: 1,
      positionData: {
        startIndex: 0,
        endIndex: passage.length,
        rects: [{ x: 40, y: 40, width: 160, height: 24 }],
      },
    },
  });
  await page.reload();

  // Scope to the panel: the passage can also appear in the page's text layer
  const chatPanel = page.locator("main > div").last();
  await chatPanel.getByText(passage, { exact: true }).click({ timeout: 60000 });
  await expect(chatPanel.getByPlaceholder("質問を入力...")).toBeVisible();

  const saved = placeSaved(page);
  await page.getByRole("button", { name: "チャットを隠す" }).click();
  await expect(page.getByPlaceholder("質問を入力...")).toBeHidden();
  // The chat being open is still the URL's — it names a highlight — while the
  // pane being folded is the book's, so the reload below needs the save in.
  await expect(page).toHaveURL(/\?page=1&selection=[A-Z0-9]+$/);
  await saved;

  await page.reload();

  // Still folded, with the conversation waiting behind it rather than the list
  await expect(page.getByRole("button", { name: "チャットを表示" })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByPlaceholder("質問を入力...")).toBeHidden();

  await page.getByRole("button", { name: "チャットを表示" }).click();
  await expect(page.getByPlaceholder("質問を入力...")).toBeVisible();
  await expect(page.getByRole("button", { name: "一覧に戻る" })).toBeVisible();
});

/**
 * An answer the reader can pick a passage out of, put there without a model.
 *
 * Both directions of the chat endpoint are answered here: the history the
 * panel reads on opening a highlight, and the question it sends. The key in
 * `.dev.vars` is a dummy, so a real send would sit there until the timeout,
 * and nothing about quoting depends on what the model would have said.
 */
async function stubConversation(page: Page, answer: string): Promise<{ sent: string[] }> {
  const sent: string[] = [];
  await page.route("**/api/pdf/*/selections/*/chats", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          selectionId: request.url().split("/selections/")[1].split("/")[0],
          messages: [
            {
              id: "stub-answer",
              role: "assistant",
              content: answer,
              createdAt: new Date(0).toISOString(),
            },
          ],
        },
      });
      return;
    }
    sent.push((request.postDataJSON() as { content: string }).content);
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        `event: token\ndata: ${JSON.stringify({ content: "承知しました" })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ messageId: "stub-reply" })}\n\n`,
    });
  });
  return { sent };
}

/** Drags across the text of an element, the way a reader picks a passage out. */
async function dragAcross(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const middle = box.y + box.height / 2;
  await page.mouse.move(box.x - 4, middle);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 4, middle, { steps: 12 });
  await page.mouse.up();
}

test("a passage picked out of an answer is quoted in the next question", async ({ page }) => {
  const pdfId = await openTestBook(page);
  const passage = pageText(2).body[0];
  await page.request.post(`/api/pdf/${pdfId}/selections`, {
    data: {
      selectedText: passage,
      pageNumber: 1,
      positionData: {
        startIndex: 0,
        endIndex: passage.length,
        rects: [{ x: 40, y: 40, width: 160, height: 24 }],
      },
    },
  });

  const answer = "Durable Objects は状態を一箇所に集めます";
  const { sent } = await stubConversation(page, answer);
  await page.reload();

  // Scope to the panel: the highlight's passage is also in the page's text layer
  const chatPanel = page.locator("main > div").last();
  await chatPanel.getByText(passage, { exact: true }).click({ timeout: 60000 });
  const answerText = chatPanel.getByText(answer, { exact: true });
  await expect(answerText).toBeVisible();

  // The quote box under the input starts on the highlight the thread hangs off
  await expect(chatPanel.getByText(passage, { exact: true })).toBeVisible();

  await dragAcross(page, answerText);
  await chatPanel.getByRole("button", { name: "引用して質問" }).click();

  // Now it is the passage from the answer — in the box as well as in the bubble
  await expect(chatPanel.getByText(answer, { exact: true })).toHaveCount(2);

  await chatPanel.getByRole("button", { name: "引用を取り消す" }).click();
  await expect(chatPanel.getByText(answer, { exact: true })).toHaveCount(1);
  await expect(chatPanel.getByText(passage, { exact: true })).toBeVisible();

  await dragAcross(page, answerText);
  await chatPanel.getByRole("button", { name: "引用して質問" }).click();
  await chatPanel.getByPlaceholder("質問を入力...").fill("これはどういう意味ですか");
  await chatPanel.getByRole("button", { name: "送信" }).click();

  // The quote travels inside the message, so it is in the thread and on the wire
  await expect(chatPanel.getByText(`> ${answer}\n\nこれはどういう意味ですか`)).toBeVisible();
  expect(sent).toStrictEqual([`> ${answer}\n\nこれはどういう意味ですか`]);
});

test("dragging the splitter keeps the whole page inside the narrowed panel", async ({ page }) => {
  await openTestBook(page);
  // The outline takes a fixed 240px out of the panel; hiding it lets the page
  // use the whole width, so the drag translates directly into the PDF's size
  await page.getByRole("button", { name: "目次を隠す" }).click();

  const canvas = page.locator("canvas.block").first();
  await expect(canvas).toBeVisible({ timeout: 60000 });
  const widthBefore = await settledCanvasWidth(page);

  const handle = page.getByRole("separator", { name: "PDFとチャットの幅を変更" });
  const box = (await handle.boundingBox())!;
  const y = box.y + box.height / 2;
  const handleX = box.x + box.width / 2;
  // Far enough that the page runs out of width before it runs out of height:
  // a smaller drag leaves the page fitted to the pane's height and unchanged.
  const shift = 450;

  await page.mouse.move(handleX, y);
  await page.mouse.down();
  await page.mouse.move(handleX - shift, y, { steps: 20 });
  await page.mouse.up();

  const after = await drawnPageAndPane(page);
  expect(after.page.width).toBeLessThan(widthBefore - 120);
  expect(after.page.width).toBeLessThanOrEqual(after.pane.width);
  expect(after.page.height).toBeLessThanOrEqual(after.pane.height);
});

test("draws a page on a browser without the newest built-ins", async ({ page }) => {
  // pdf.js writes against the newest JavaScript it can, and a phone a version
  // or two behind Chrome threw `getOrInsertComputed is not a function` the
  // moment a page was drawn. Taking the method away here is that phone: the
  // `legacy` build carries a polyfill, the default build does not.
  await page.addInitScript(() => {
    // @ts-expect-error deleting a built-in on purpose, to stand in for a browser without it
    delete Map.prototype.getOrInsertComputed;
    // @ts-expect-error same
    delete WeakMap.prototype.getOrInsertComputed;
  });

  await openTestBook(page);

  // Ink on the page, not just a canvas element: a pdf.js that threw would
  // leave the canvas there and blank.
  expect(await inkRatio(page)).toBeGreaterThan(0.001);
  await expect(page.getByText("このページを表示できません")).toHaveCount(0);
});

/**
 * Where `locator` is, once it is somewhere.
 *
 * pdf.js builds the text layer again for every page, so a span asked for its
 * box while one is being swapped in reports nothing at all.
 */
async function settledBox(locator: Locator) {
  await expect.poll(async () => (await locator.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  return (await locator.boundingBox())!;
}

test("keeps no row of page controls under the page where a pointer hovers", async ({ page }) => {
  // The counter and its two arrows are for a thumb. A reader with a pointer has
  // the edges of the page and h / l, and the number of the page is nothing they
  // asked for — so the row is not drawn here at all. A finger keeps it: every
  // test in `tablet.spec.ts` opens by waiting for that counter.
  await openTestBook(page);

  // Turning still works, so what went is the row and not the way out of the page
  const pane = page.locator("main .overflow-auto").first();
  const box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(drawnPage(page, 2).first()).toBeVisible();

  await expect(page.getByRole("button", { name: "次のページ" })).toBeHidden();
  await expect(page.getByRole("button", { name: "前のページ" })).toBeHidden();
  await expect(page.getByText(`2 / ${PAGE_COUNT}`, { exact: true })).toBeHidden();
});

test("turns the page on a click at the edge, but not on a drag that selected text", async ({
  page,
}) => {
  // The edges answer a mouse as well as a finger. What must not answer is the
  // drag a reader makes to select a passage — that is how they ask a question,
  // and losing the page under it would lose the passage too.
  await openTestBook(page);
  const pane = page.locator("main .overflow-auto").first();
  const box = (await pane.boundingBox())!;

  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(drawnPage(page, 2).first()).toBeVisible();

  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
  await expect(drawnPage(page, 1).first()).toBeVisible();

  // A drag over a line lands in the same band, and stays on the page
  const line = page.locator(".textLayer span").first();
  const lineBox = await settledBox(line);
  // The drag has to begin inside the band a click turns the page from, or the
  // guard it is here to check is never asked. `TAP_EDGE` is 0.3 of the pane.
  expect(lineBox.x).toBeLessThan(box.x + box.width * 0.3);
  await page.mouse.move(lineBox.x + 1, lineBox.y + lineBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lineBox.x + lineBox.width - 1, lineBox.y + lineBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();

  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });
  await expect(drawnPage(page, 1).first()).toBeVisible();
});

test("the click that puts the question box away does not also turn the page", async ({ page }) => {
  // Dismissing the box is a click outside it, and the box goes on `mousedown`.
  // Whether a turn was on offer therefore has to be read when the press lands:
  // by the time the button comes up there is no box left to see, and the
  // reader would be carried off the page they were only trying to get back to.
  await openTestBook(page);
  const pane = page.locator("main .overflow-auto").first();
  const box = (await pane.boundingBox())!;

  const line = page.locator(".textLayer span").first();
  const lineBox = await settledBox(line);
  await page.mouse.move(lineBox.x + 1, lineBox.y + lineBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lineBox.x + lineBox.width - 1, lineBox.y + lineBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "質問する" })).toBeVisible({ timeout: 10000 });

  // Low in the pane, clear of the box that opened against the first line
  const dismissY = box.y + box.height * 0.85;
  await page.mouse.click(box.x + box.width * 0.9, dismissY);

  await expect(page.getByRole("button", { name: "質問する" })).toHaveCount(0);
  await expect(drawnPage(page, 1).first()).toBeVisible();

  // The same click again, with nothing left to put away, does turn the page —
  // so the edge really was live and the first click was refused on purpose
  await page.mouse.click(box.x + box.width * 0.9, dismissY);
  await expect(drawnPage(page, 2).first()).toBeVisible();
});
