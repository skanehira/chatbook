import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { ChatMessageBubble } from "./ChatMessageBubble";
import type { ChatMessage } from "../../atoms/chatAtom";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

describe("ChatMessageBubble", () => {
  it("renders emphasis in an assistant answer as markdown", () => {
    render(
      <ChatMessageBubble message={message({ content: "Workers は **エッジ** で動きます" })} />,
    );

    const strong = screen.getByText("エッジ");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders a markdown list as list items", () => {
    render(<ChatMessageBubble message={message({ content: "- 高速\n- 低コスト" })} />);

    expect(screen.getByText("高速").closest("li")).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders fenced code as a code block", () => {
    render(<ChatMessageBubble message={message({ content: "```\nexport default app\n```" })} />);

    const code = screen.getByText("export default app");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("colors keywords in a fenced code block that names its language", () => {
    const { container } = render(
      <ChatMessageBubble message={message({ content: "```js\nconst app = 1\n```" })} />,
    );

    const code = container.querySelector("pre code");
    expect(code?.className).toBe("block hljs language-js");
    expect(screen.getByText("const").className).toBe("hljs-keyword");
  });

  // The answer streams in token by token, so a fence is rendered many times
  // while its language is still half-typed and names nothing that exists
  it.each([
    ["a language nothing can highlight", "```mermaid\ngraph TD\n```"],
    ["a language name still being streamed", "```typescr\ngraph TD"],
  ])("renders a code block with %s as plain text", (_name, content) => {
    const { container } = render(<ChatMessageBubble message={message({ content })} />);

    // innerHTML, because highlighting would break the code into <span>s while
    // leaving textContent identical
    const code = container.querySelector("pre code");
    expect(code?.innerHTML).toBe("graph TD\n");
  });

  it("shows the answer without the Sources section, which the badges already carry", () => {
    const content = `Workers はエッジで動きます。\n\n## Sources\n[1] 「エッジで動きます」（本書 第1章）`;
    render(
      <ChatMessageBubble
        message={message({
          content,
          citations: [{ id: "1", type: "pdf", text: "エッジで動きます", pageNumber: 3 }],
        })}
      />,
    );

    expect(screen.getByText("Workers はエッジで動きます。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "出典 [1] のページへ移動" })).toBeInTheDocument();
    expect(screen.queryByText(/本書 第1章/)).toBeNull();
  });

  it("shows the user's own message verbatim instead of parsing markdown", () => {
    render(
      <ChatMessageBubble message={message({ role: "user", content: "**これは太字ではない**" })} />,
    );

    expect(screen.getByText("**これは太字ではない**")).toBeInTheDocument();
    expect(screen.queryByText("これは太字ではない")).toBeNull();
  });
});
