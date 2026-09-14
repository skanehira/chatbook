import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { unstable_serialize } from "swr";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { SwrTestCache } from "../../../test/swrTestCache";
import type { ChatMessage } from "../../../shared/schemas/chat";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

/** A fence holding a document, captioned the way the system prompt asks for. */
const FIGURE = '```html title="シーケンス図"\n<div class="a">A</div>\n```';

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

  // react-markdown hands every renderer the mdast node the element came from.
  // Spreading it onto the DOM element writes `node="[object Object]"` into the
  // markup, which is not a real attribute and which React warns about.
  it("writes only the styling class onto the elements it renders", () => {
    const { container } = render(
      <ChatMessageBubble message={message({ content: "`Cache-Control` を付けます" })} />,
    );

    expect(container.querySelector("p")?.getAttributeNames()).toStrictEqual(["class"]);
    expect(container.querySelector("code")?.getAttributeNames()).toStrictEqual(["class"]);
  });

  it("renders fenced code as a code block", () => {
    render(<ChatMessageBubble message={message({ content: "```\nexport default app\n```" })} />);

    const code = screen.getByText("export default app");
    expect(code.closest("pre")).not.toBeNull();
  });

  // A fence that names no language gets no class from rehype-highlight, so the
  // `code` component cannot tell it from inline code and dresses it as a chip.
  // The chip's pale background lands inside the dark <pre> and swallows the text.
  it("keeps the inline code chip off a fenced block that names no language", () => {
    render(<ChatMessageBubble message={message({ content: "```\nexport default app\n```" })} />);

    const pre = screen.getByText("export default app").closest("pre");
    expect(pre?.className).toBe(
      "mb-2 overflow-x-auto rounded bg-gray-800 p-2 font-mono text-xs text-gray-100 last:mb-0 [&_code:not(.hljs)]:block [&_code:not(.hljs)]:bg-transparent [&_code:not(.hljs)]:p-0",
    );
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
  it("renders a code block whose language is still being streamed as plain text", () => {
    const { container } = render(
      <ChatMessageBubble message={message({ content: "```typescr\ngraph TD" })} />,
    );

    // innerHTML, because highlighting would break the code into <span>s while
    // leaving textContent identical
    const code = container.querySelector("pre code");
    expect(code?.innerHTML).toBe("graph TD\n");
  });

  it("draws a mermaid fence as a diagram", () => {
    const svg = '<svg aria-label="diagram"><text>Start</text></svg>';
    const { container } = render(
      // The drawn diagram stands in for mermaid itself, which needs the SVG
      // layout a browser has and jsdom does not
      <SwrTestCache seed={{ [unstable_serialize(["mermaid", "graph TD\n"])]: svg }}>
        <ChatMessageBubble message={message({ content: "```mermaid\ngraph TD\n```" })} />
      </SwrTestCache>,
    );

    expect(container.querySelector("svg")?.outerHTML).toBe(svg);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows a mermaid fence as code until its diagram has been drawn", () => {
    const { container } = render(
      // No seed, so the diagram is still on its way
      <SwrTestCache>
        <ChatMessageBubble message={message({ content: "```mermaid\ngraph TD\n```" })} />
      </SwrTestCache>,
    );

    const code = container.querySelector("pre code");
    expect(code?.innerHTML).toBe("graph TD\n");
  });

  // The figure itself is a document the bubble's markdown renderer cannot run,
  // so the fence becomes the way to open it instead of the code it is written in
  it("shows an html fence as the link that opens it, not as code", () => {
    const { container } = render(<ChatMessageBubble message={message({ content: FIGURE })} />);

    expect(screen.getByRole("button", { name: "シーケンス図" })).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("names the link 図解を見る when the fence carries no caption", () => {
    render(<ChatMessageBubble message={message({ content: "```html\n<div>A</div>\n```" })} />);

    expect(screen.getByRole("button", { name: "図解を見る" })).toBeInTheDocument();
  });

  // The fence arrives a token at a time, so for most of the answer's life it
  // holds half a document
  it("shows an html fence as code while the answer is still streaming", () => {
    const { container } = render(
      <ChatMessageBubble streaming message={message({ content: FIGURE })} />,
    );

    expect(container.querySelector("pre")?.textContent).toBe('<div class="a">A</div>\n');
    expect(screen.queryByRole("button", { name: "シーケンス図" })).toBeNull();
  });

  // highlight.js splits an html fence into `hljs-*` spans, so the source has to
  // be gathered back out of them. This is the only test that says it was: a
  // fence read straight off its first child never reaches the popup at all.
  it("hands the popup the answer's own html, not the spans highlighting broke it into", async () => {
    const user = userEvent.setup();
    render(<ChatMessageBubble message={message({ content: FIGURE })} />);

    await user.click(screen.getByRole("button", { name: "シーケンス図" }));

    expect(screen.getByTitle("シーケンス図").getAttribute("srcdoc")).toBe(
      '<!doctype html>\n<div class="a">A</div>\n',
    );
  });

  it("turns a [1] in the answer body into the control that jumps to its page", () => {
    const content = `Workers はエッジで動きます[1]。\n\n## Sources\n[1] 「エッジで動きます」（本書 第1章）`;
    render(
      <ChatMessageBubble
        message={message({
          content,
          citations: [{ id: "1", type: "pdf", text: "エッジで動きます", pageNumber: 3 }],
        })}
      />,
    );

    const link = screen.getByRole("button", { name: "出典 [1] のページへ移動" });
    expect(link.textContent).toBe("[1]");
  });

  it("shows the answer without the Sources section, which the body's links replace", () => {
    const content = `Workers はエッジで動きます[1]。\n\n## Sources\n[1] 「エッジで動きます」（本書 第1章）`;
    const { container } = render(
      <ChatMessageBubble
        message={message({
          content,
          citations: [{ id: "1", type: "pdf", text: "エッジで動きます", pageNumber: 3 }],
        })}
      />,
    );

    // The bubble holds the answer and nothing else: the quoted passage was in
    // the stripped section, and "Sources:" headed the badge row that used to
    // stand underneath it
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("Workers はエッジで動きます[1]。");
  });

  it("leaves a [2] with no citation of its own as plain text", () => {
    const { container } = render(
      <ChatMessageBubble
        message={message({
          content: "根拠は[1]と[2]です。",
          citations: [{ id: "1", type: "pdf", text: "エッジで動きます", pageNumber: 3 }],
        })}
      />,
    );

    // [1] is the only control; the sentence still reads with both markers in it
    const links = screen.getAllByRole("button");
    expect(links.map((el) => el.getAttribute("aria-label"))).toStrictEqual([
      "出典 [1] のページへ移動",
    ]);
    expect(container.querySelector("p")?.textContent).toBe("根拠は[1]と[2]です。");
  });

  // The answer streams in before its citations do, so every `[n]` in it is a
  // reference to something the panel does not have yet
  it("leaves a [1] in an answer that carries no citations as plain text", () => {
    render(<ChatMessageBubble message={message({ content: "根拠は[1]です。" })} />);

    expect(screen.getByText("根拠は[1]です。")).toBeInTheDocument();
  });

  it("shows the user's own message verbatim instead of parsing markdown", () => {
    render(
      <ChatMessageBubble message={message({ role: "user", content: "**これは太字ではない**" })} />,
    );

    expect(screen.getByText("**これは太字ではない**")).toBeInTheDocument();
    expect(screen.queryByText("これは太字ではない")).toBeNull();
  });
});
