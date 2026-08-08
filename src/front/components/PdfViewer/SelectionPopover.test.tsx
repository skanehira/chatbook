import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionPopover } from "./SelectionPopover";

function renderPopover() {
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  render(<SelectionPopover onSubmit={onSubmit} onDismiss={onDismiss} />);
  return {
    onSubmit,
    onDismiss,
    input: screen.getByPlaceholderText("選択した文章について質問する..."),
  };
}

describe("SelectionPopover", () => {
  it("sends the typed question when Enter is pressed", async () => {
    const { onSubmit, input } = renderPopover();
    await userEvent.type(input, "この段落を一言で要約して");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit.mock.calls).toEqual([["この段落を一言で要約して"]]);
  });

  it("sends the typed question when the ask button is clicked", async () => {
    const { onSubmit, input } = renderPopover();
    await userEvent.type(input, "この段落を一言で要約して");

    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    expect(onSubmit.mock.calls).toEqual([["この段落を一言で要約して"]]);
  });

  it("asks once while the first ask is still in flight", async () => {
    // The popover now stays open until the highlight is stored, so a second
    // submit during that window used to create a second highlight and a second
    // answer that killed the first one's stream.
    let finishAsking!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAsking = resolve;
        }),
    );
    render(<SelectionPopover onSubmit={onSubmit} onDismiss={vi.fn()} />);
    const input = screen.getByPlaceholderText("選択した文章について質問する...");
    await userEvent.type(input, "この段落を一言で要約して");

    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    // The reader can see the ask is under way, and neither the button nor
    // Enter starts a second one
    const asking = screen.getByRole("button", { name: "送信中..." });
    expect(asking).toBeDisabled();
    await userEvent.click(asking);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit.mock.calls).toEqual([["この段落を一言で要約して"]]);

    await act(async () => {
      finishAsking();
    });
  });

  it("lets the reader ask again once a failed ask has finished", async () => {
    // The popover is kept open on failure precisely so the question can be
    // sent again; it must not stay stuck in its sending state.
    let failAsking!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          failAsking = () => reject(new Error("Server exploded"));
        }),
    );
    render(<SelectionPopover onSubmit={onSubmit} onDismiss={vi.fn()} />);
    const input = screen.getByPlaceholderText("選択した文章について質問する...");
    await userEvent.type(input, "この段落を一言で要約して");

    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    await act(async () => {
      failAsking();
    });

    await userEvent.click(await screen.findByRole("button", { name: "質問する" }));

    expect(onSubmit.mock.calls).toEqual([
      ["この段落を一言で要約して"],
      ["この段落を一言で要約して"],
    ]);
  });

  it("keeps the question unsent when Enter only confirms an IME conversion", async () => {
    const { onSubmit, input } = renderPopover();
    await userEvent.type(input, "これはなに");

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input).toHaveValue("これはなに");
    expect(onSubmit.mock.calls).toEqual([]);
  });
});
