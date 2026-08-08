import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "./ChatInput";

function renderInput() {
  const onSend = vi.fn();
  render(<ChatInput onSend={onSend} quotedText="テキスト選択の仕組み" />);
  return { onSend, input: screen.getByPlaceholderText("質問を入力...") };
}

describe("ChatInput", () => {
  it("sends the typed question when Enter is pressed", async () => {
    const { onSend, input } = renderInput();
    await userEvent.type(input, "もう少し詳しく");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend.mock.calls).toEqual([["もう少し詳しく"]]);
    expect(input).toHaveValue("");
  });

  it("sends the typed question when the send button is clicked", async () => {
    const { onSend, input } = renderInput();
    await userEvent.type(input, "もう少し詳しく");

    await userEvent.click(screen.getByRole("button", { name: "送信" }));

    expect(onSend.mock.calls).toEqual([["もう少し詳しく"]]);
    expect(input).toHaveValue("");
  });

  it("keeps the question unsent when Enter only confirms an IME conversion", async () => {
    const { onSend, input } = renderInput();
    await userEvent.type(input, "これはなに");

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input).toHaveValue("これはなに");
    expect(onSend.mock.calls).toEqual([]);
  });
});
