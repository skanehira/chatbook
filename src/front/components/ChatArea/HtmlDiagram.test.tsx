import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HtmlDiagram } from "./HtmlDiagram";

const DIAGRAM = "<div>A → B</div>";
const CAPTION = "シーケンス図";

function showDiagram(caption: string | null = CAPTION) {
  render(<HtmlDiagram html={DIAGRAM} caption={caption} />);

  return userEvent.setup();
}

describe("HtmlDiagram", () => {
  it("shows the caption as the link that opens the diagram", () => {
    showDiagram();

    expect(screen.getByRole("button", { name: CAPTION })).toBeInTheDocument();
  });

  // The frame is given scripts so a diagram may draw itself, and denied the
  // app's origin so nothing in it can reach the session the reader is in
  it("opens the document in a frame that can run scripts but not reach the app", async () => {
    const user = showDiagram();

    await user.click(screen.getByRole("button", { name: CAPTION }));

    const frame = screen.getByTitle(CAPTION);
    expect(frame.getAttribute("srcdoc")).toBe(`<!doctype html>\n${DIAGRAM}`);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("closes the popup on escape", async () => {
    const user = showDiagram();
    await user.click(screen.getByRole("button", { name: CAPTION }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the popup when the backdrop is clicked", async () => {
    const user = showDiagram();
    await user.click(screen.getByRole("button", { name: CAPTION }));

    const backdrop = screen.getByRole("dialog").parentElement;
    if (backdrop === null) throw new Error("the dialog has no backdrop");
    await user.click(backdrop);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the link 図解を見る when the fence carries no caption", () => {
    showDiagram(null);

    expect(screen.getByRole("button", { name: "図解を見る" })).toBeInTheDocument();
  });

  // The reader who clicked the header left focus on the body, which no
  // wrapper's onKeyDown ever sees: this is the test that says why escape is
  // read off the document instead.
  it("still closes on escape after a click that left focus on the body", async () => {
    const user = showDiagram();
    await user.click(screen.getByRole("button", { name: CAPTION }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("heading", { name: CAPTION }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The page-turn keys are read from `window`, one step further out than the
  // document the popup listens on. These two are one promise between them:
  // alone, either cannot tell "the figure holds on to the keys" from "the
  // reader's presses never arrived", so they are kept as a pair.
  it("keeps the page-turn keys from reaching the page while it is open", async () => {
    const user = showDiagram();
    const pageTurns = vi.fn();
    window.addEventListener("keydown", pageTurns);
    await user.click(screen.getByRole("button", { name: CAPTION }));

    await user.keyboard("{ArrowRight}");

    window.removeEventListener("keydown", pageTurns);
    expect(pageTurns).not.toHaveBeenCalled();
  });

  it("lets the page-turn keys through once the figure is closed", async () => {
    const user = showDiagram();
    const pageTurns = vi.fn();
    window.addEventListener("keydown", pageTurns);
    await user.click(screen.getByRole("button", { name: CAPTION }));
    await user.click(screen.getByRole("button", { name: "図解を閉じる" }));

    await user.keyboard("{ArrowRight}");

    window.removeEventListener("keydown", pageTurns);
    expect(pageTurns).toHaveBeenCalled();
  });
});
