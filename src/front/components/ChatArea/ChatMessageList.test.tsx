import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { ChatMessageList } from "./ChatMessageList";
import type { ChatMessage } from "../../atoms/chatAtom";

const question: ChatMessage = {
  id: "m1",
  role: "user",
  content: "この段落を一言で要約して",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("ChatMessageList", () => {
  it("shows the question and a waiting indicator while no token has arrived yet", () => {
    render(<ChatMessageList messages={[question]} streamingContent="" isStreaming={true} />);

    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/^考え中…$/);
  });

  it("replaces the waiting indicator with the answer once tokens start arriving", () => {
    const { rerender } = render(
      <ChatMessageList messages={[question]} streamingContent="" isStreaming={true} />,
    );

    rerender(
      <ChatMessageList messages={[question]} streamingContent="要約すると" isStreaming={true} />,
    );

    expect(screen.getByText("要約すると")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows only the finished conversation when nothing is streaming", () => {
    const answer: ChatMessage = {
      id: "m2",
      role: "assistant",
      content: "要約すると、これはテキスト選択の話です。",
      createdAt: "2026-01-01T00:00:01.000Z",
    };

    render(
      <ChatMessageList messages={[question, answer]} streamingContent="" isStreaming={false} />,
    );

    expect(screen.getByText("この段落を一言で要約して")).toBeVisible();
    expect(screen.getByText("要約すると、これはテキスト選択の話です。")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
