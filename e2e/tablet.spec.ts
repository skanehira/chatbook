import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_FILE_NAME, PAGE_COUNT } from "./fixtures/testBookManifest.ts";

/**
 * The reader on a screen wide enough for two panes, touched rather than
 * pointed at.
 *
 * Every gesture used to be gated on the window being narrow, so a tablet fell
 * through to the mouse-only paths: the splitter would not move, the edges did
 * not turn the page, and — worst — a passage could not be selected at all,
 * because the wide layout read the selection off `mouseup` and a finger never
 * lets a button go. These are the tests for that combination.
 *
 * Not covered here: the long press itself. Playwright drives `tap` and nothing
 * more — the platform's own selection gesture cannot be synthesised
 * (`docs/PDF_TEXT_SELECTION.md` §8). The selection below is made with the mouse,
 * which still proves what changed: that it is picked up by settling rather than
 * by a button coming up, at this width.
 */

const TEST_PDF = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  FIXTURE_FILE_NAME,
);

function pageLabel(pageNumber: number): string {
  return `${pageNumber} / ${PAGE_COUNT}`;
}

async function logIn(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "demo", password: "demo" },
  });
  expect(response.status()).toBe(200);
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
    readingState: {
      page: number;
      bookChat: boolean | null;
      outlineOpen: boolean | null;
      chatPanelOpen: boolean | null;
    } | null;
  };
  for (const selection of selections) {
    await page.request.delete(`/api/pdf/${pdfId}/selections/${selection.id}`);
  }

  // The three specs share this book, and the reader's place — both panels
  // included — is kept on the server now: uploading goes through the shelf,
  // which names no page, so an earlier test's place would be where this one
  // opens.
  await page.request.put(`/api/pdf/${pdfId}/reading-state`, {
    // `bookChat` is spelled out because leaving it out keeps whatever was
    // stored: a conversation about the book itself, left open by an earlier
    // test, would otherwise be the one this one opens on.
    data: {
      page: 1,
      selectionId: null,
      bookChat: false,
      outlineOpen: true,
      chatPanelOpen: true,
    },
  });

  // Reload only where the reader is showing something the reset has just
  // replaced: a second load of the book costs as much as the first one.
  const resumedElsewhere =
    readingState !== null &&
    (readingState.page !== 1 ||
      readingState.bookChat === true ||
      readingState.outlineOpen === false ||
      readingState.chatPanelOpen === false);
  if (selections.length > 0 || resumedElsewhere) {
    await page.goto(`/books/${pdfId}?page=1`);
  }
  // The page counter arrives with the book, but a tap or a drag needs the page
  // itself to have been drawn.
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.locator("canvas.block")).toBeVisible({ timeout: 60000 });
  return pdfId;
}

/** The pane the page is drawn and scrolled in. */
function pagePane(page: Page) {
  return page.locator("main .overflow-auto").first();
}

test("opens with both panes, the way a wide window does", async ({ page }) => {
  await openTestBook(page);

  await expect(page.getByRole("separator")).toBeVisible();
  await expect(page.getByRole("button", { name: "チャットを隠す" })).toBeVisible();
});

test("keeps the row of page controls under the page where nothing can hover", async ({ page }) => {
  // A window this wide is a laptop's as far as a width can tell, and a laptop
  // does not get this row (`chatbook.spec.ts`, "keeps no row of page controls…").
  // What is left of it here is the whole reason the two are told apart by what
  // the device can do rather than by how wide it is — asserted as a subject of
  // its own, because the counter the other tests wait for is a readiness signal
  // that may be moved off it.
  await openTestBook(page);

  await expect(page.getByRole("button", { name: "前のページ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "次のページ" })).toBeVisible();
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible();

  // ...and it turns the page, rather than merely being drawn
  await page.getByRole("button", { name: "次のページ" }).tap();
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();
});

/**
 * Chooses a passage the way a finger does: a touch on the page, then the
 * selection the platform's own long press would have ended at.
 *
 * The gesture itself cannot be synthesised (`docs/PDF_TEXT_SELECTION.md` §8),
 * and a mouse drag would not do — it would let the old `mouseup` path answer,
 * and it would report the wrong kind of pointer. The tap is what says a finger
 * chose this; it lands in the middle of the page, which is the one band that
 * neither turns the page nor is anything else.
 */
async function pickPassageWithAFinger(page: Page): Promise<void> {
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  const pane = (await pagePane(page).boundingBox())!;
  await page.touchscreen.tap(pane.x + pane.width / 2, pane.y + pane.height / 2);

  await page.evaluate(() => {
    const line = document.querySelector(".textLayer span")!;
    const range = document.createRange();
    range.selectNodeContents(line);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test("offers a passage a finger chose without taking the keyboard with it", async ({ page }) => {
  // Two things were wrong here. The wide layout read the selection off
  // `mouseup`, which a finger never sends, so nothing was offered at all; and
  // once it was, the box opened straight onto the passage and took the focus,
  // which collapses the selection and takes away the handles the reader was
  // still adjusting.
  await openTestBook(page);

  await pickPassageWithAFinger(page);

  await expect(page.getByRole("button", { name: "AIに質問" })).toBeVisible({ timeout: 10000 });
  // Nothing has asked for the keyboard yet, and the passage is still selected
  await expect(page.getByPlaceholder("選択した文章について質問する...")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(
    0,
  );
});

test("opens the question box on a finger only once it is asked for", async ({ page }) => {
  await openTestBook(page);
  await pickPassageWithAFinger(page);

  await page.getByRole("button", { name: "AIに質問" }).tap();

  await expect(page.getByPlaceholder("選択した文章について質問する...")).toBeVisible();
});

test("turns the page on a tap at the edge, and leaves the middle alone", async ({ page }) => {
  await openTestBook(page);
  const pane = (await pagePane(page).boundingBox())!;
  const middleY = pane.y + pane.height / 2;

  await page.touchscreen.tap(pane.x + pane.width * 0.9, middleY);
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();

  await page.touchscreen.tap(pane.x + pane.width * 0.1, middleY);
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible();

  // The middle belongs to the double tap that zooms
  await page.touchscreen.tap(pane.x + pane.width * 0.5, middleY);
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible();

  // Asserting page 1 straight after the middle tap would pass whether the tap
  // was ignored or had not been acted on yet. Turning the page from here says
  // which: a middle tap that had counted would land on 3 instead.
  await page.touchscreen.tap(pane.x + pane.width * 0.9, middleY);
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();
});

test("lets a finger drag the handle between the panes", async ({ page }) => {
  // Real touch input rather than events built by hand: `setPointerCapture`
  // wants a pointer the browser is actually tracking, and a synthesised
  // `pointerdown` has no such pointer behind it.
  await openTestBook(page);
  const before = (await pagePane(page).boundingBox())!;
  const grip = (await page.getByRole("separator").boundingBox())!;
  const y = grip.y + grip.height / 2;
  const from = grip.x + grip.width / 2;

  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from, y }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: from - 200, y }],
  });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  // The pane follows the finger, so it should have given up about the 200px
  // the finger travelled. A loose "narrower than before" would also pass for a
  // handle that moved a token amount and stopped.
  const after = (await pagePane(page).boundingBox())!;
  expect(before.width - after.width).toBeGreaterThan(160);
  expect(before.width - after.width).toBeLessThan(240);
});

test("keeps the delete button reachable where nothing can hover", async ({ page }) => {
  await openTestBook(page);

  await page.goto("/");
  const remove = page.getByRole("button", { name: /を削除$/ }).first();

  // Visible without a pointer ever resting on the card. Playwright counts a
  // fully transparent element as visible, so the opacity is what carries this.
  await expect(remove).toBeVisible();
  await expect(remove).toHaveCSS("opacity", "1");
});
