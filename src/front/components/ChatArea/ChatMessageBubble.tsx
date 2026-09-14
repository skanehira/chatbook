import { useMemo, type ElementType } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "../../../shared/schemas/chat";
import type { Citation } from "../../../shared/schemas/citation";
import { CitationLink } from "./CitationLink";
import { MermaidBlock } from "./MermaidBlock";
import { stripSources } from "../../../shared/lib/stripSources";
import { citationIdFromHref, linkifyCitationRefs } from "../../lib/citationRefs";

/** The `<pre>` node react-markdown hands over, holding the fence's `<code>` child. */
type FenceNode = NonNullable<ExtraProps["node"]>;

/** What a fenced block of the given language holds, or null for any other block. */
function fenceSource(node: FenceNode | undefined, language: string): string | null {
  const code = node?.children[0];
  if (code?.type !== "element") return null;

  // rehype-highlight leaves the fence's `language-x` in place and adds `hljs`
  // next to it, so the class list has to be searched
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.includes(`language-${language}`)) return null;

  const source = code.children[0];
  return source?.type === "text" ? source.value : null;
}

/**
 * A renderer that puts one class on one element and passes the rest through.
 *
 * react-markdown hands every renderer the mdast `node` the element was built
 * from. Spreading it onto the DOM element would write `node="[object Object]"`
 * into the markup, so it is dropped here once instead of at each element below.
 */
function withClass(Tag: ElementType, className: string) {
  return function Styled({ node: _node, ...props }: ExtraProps) {
    return <Tag className={className} {...props} />;
  };
}

/** What react-markdown hands the `a` renderer, of which only `href` is read. */
type AnchorProps = { href?: string } & ExtraProps;

/** A link the answer wrote itself, which always leaves the app. */
function PlainAnchor({ node: _node, ...props }: AnchorProps) {
  return (
    <a className="text-blue-600 underline" target="_blank" rel="noopener noreferrer" {...props} />
  );
}

/**
 * The `a` renderer for one answer: the markers `linkifyCitationRefs` rewrote
 * become citation links, everything else stays an ordinary link.
 *
 * Built per answer because the sources are what a marker is resolved against,
 * and defined out here so a re-render does not hand react-markdown a component
 * type it has never seen and remount the whole body.
 */
function citationAnchor(citations: Citation[] | null | undefined) {
  return function CitationAnchor(props: AnchorProps) {
    const id = citationIdFromHref(props.href);
    const citation = id === null ? undefined : citations?.find((c) => c.id === id);

    return citation ? <CitationLink citation={citation} /> : <PlainAnchor {...props} />;
  };
}

interface ChatMessageBubbleProps {
  /** Only what the bubble renders; a streaming answer has no id or timestamp yet. */
  message: Pick<ChatMessage, "role" | "content" | "citations">;
}

/**
 * Minimal element styling for the answer body. Tailwind resets the defaults, so
 * without these the markdown would render as an undifferentiated block.
 */
const MARKDOWN_COMPONENTS = {
  p: withClass("p", "mb-2 last:mb-0"),
  h1: withClass("h1", "mb-2 mt-3 text-base font-bold first:mt-0"),
  h2: withClass("h2", "mb-2 mt-3 text-sm font-bold first:mt-0"),
  h3: withClass("h3", "mb-1 mt-2 text-sm font-semibold first:mt-0"),
  ul: withClass("ul", "mb-2 list-disc pl-5 last:mb-0"),
  ol: withClass("ol", "mb-2 list-decimal pl-5 last:mb-0"),
  li: withClass("li", "mb-0.5"),
  strong: withClass("strong", "font-semibold"),
  a: PlainAnchor,
  // rehype-highlight prepends `hljs` to the fence's `language-x`, so the class
  // that marks a block has to be searched for rather than matched at the start
  code: ({ className, node: _node, ...props }: { className?: string } & ExtraProps) =>
    className?.includes("language-") ? (
      <code className={`block ${className}`} {...props} />
    ) : (
      <code
        className={`rounded bg-gray-200 px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
        {...props}
      />
    ),
  // A mermaid fence is swapped for the diagram it describes. The swap happens
  // here rather than in `code` so the drawn diagram is not boxed inside the
  // dark <pre> a code block wears.
  //
  // A fence naming no language is left classless by rehype-highlight, so `code`
  // above reads it as inline and dresses it as a pale chip — unreadable against
  // this dark background. The chip is undressed from here, where the fence is
  // known to be a block. Fences highlight.js did touch keep their `hljs` look.
  pre: ({ node, ...props }: { node?: FenceNode }) => {
    const plain = (
      <pre
        className="mb-2 overflow-x-auto rounded bg-gray-800 p-2 font-mono text-xs text-gray-100 last:mb-0 [&_code:not(.hljs)]:block [&_code:not(.hljs)]:bg-transparent [&_code:not(.hljs)]:p-0"
        {...props}
      />
    );
    const diagram = fenceSource(node, "mermaid");
    return diagram === null ? plain : <MermaidBlock code={diagram} fallback={plain} />;
  },
  blockquote: withClass(
    "blockquote",
    "mb-2 border-l-2 border-gray-300 pl-2 text-gray-600 last:mb-0",
  ),
  // The only element that is not styled in place: the scroll box a wide table
  // needs has to sit outside the table itself
  table: ({ node: _node, ...props }: ExtraProps) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: withClass("th", "border border-gray-300 px-2 py-1 text-left"),
  td: withClass("td", "border border-gray-300 px-2 py-1"),
  hr: withClass("hr", "my-2 border-gray-300"),
};

export function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const citations = message.citations;

  const components = useMemo(
    () => ({ ...MARKDOWN_COMPONENTS, a: citationAnchor(citations) }),
    [citations],
  );

  const body = useMemo(() => {
    const answer = stripSources(message.content);
    return citations && citations.length > 0
      ? linkifyCitationRefs(answer, new Set(citations.map((c) => c.id)))
      : answer;
  }, [message.content, citations]);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-blue-600 text-white rounded-br-sm"
            : "bg-gray-100 text-gray-800 rounded-bl-sm"
        }`}
      >
        {isUser ? (
          // The user's own text is shown as typed, not interpreted as markdown
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="break-words">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={components}
            >
              {body}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
