import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("keeps the question unsent when Enter only confirms an IME conversion", async () => {
    const { onSubmit, input } = renderPopover();
    await userEvent.type(input, "これはなに");

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input).toHaveValue("これはなに");
    expect(onSubmit.mock.calls).toEqual([]);
  });
});
