import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "../../atoms/chatAtom";
import { CitationBadge } from "./CitationBadge";
import { stripSources } from "../../lib/stripSources";

interface ChatMessageBubbleProps {
  message: ChatMessage;
}

/**
 * Minimal element styling for the answer body. Tailwind resets the defaults, so
 * without these the markdown would render as an undifferentiated block.
 */
const MARKDOWN_COMPONENTS = {
  p: (props: object) => <p className="mb-2 last:mb-0" {...props} />,
  h1: (props: object) => <h1 className="mb-2 mt-3 text-base font-bold first:mt-0" {...props} />,
  h2: (props: object) => <h2 className="mb-2 mt-3 text-sm font-bold first:mt-0" {...props} />,
  h3: (props: object) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0" {...props} />,
  ul: (props: object) => <ul className="mb-2 list-disc pl-5 last:mb-0" {...props} />,
  ol: (props: object) => <ol className="mb-2 list-decimal pl-5 last:mb-0" {...props} />,
  li: (props: object) => <li className="mb-0.5" {...props} />,
  strong: (props: object) => <strong className="font-semibold" {...props} />,
  a: (props: object) => (
    <a className="text-blue-600 underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  // rehype-highlight prepends `hljs` to the fence's `language-x`, so the class
  // that marks a block has to be searched for rather than matched at the start
  code: ({ className, ...props }: { className?: string }) =>
    className?.includes("language-") ? (
      <code className={`block ${className}`} {...props} />
    ) : (
      <code
        className={`rounded bg-gray-200 px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
        {...props}
      />
    ),
  pre: (props: object) => (
    <pre
      className="mb-2 overflow-x-auto rounded bg-gray-800 p-2 font-mono text-xs text-gray-100 last:mb-0"
      {...props}
    />
  ),
  blockquote: (props: object) => (
    <blockquote
      className="mb-2 border-l-2 border-gray-300 pl-2 text-gray-600 last:mb-0"
      {...props}
    />
  ),
  table: (props: object) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: (props: object) => <th className="border border-gray-300 px-2 py-1 text-left" {...props} />,
  td: (props: object) => <td className="border border-gray-300 px-2 py-1" {...props} />,
  hr: (props: object) => <hr className="my-2 border-gray-300" {...props} />,
};

export function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";

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
              components={MARKDOWN_COMPONENTS}
            >
              {stripSources(message.content)}
            </Markdown>
          </div>
        )}

        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <p className="text-xs text-gray-500 mb-1">Sources:</p>
            <div className="flex flex-wrap gap-1">
              {message.citations.map((c) => (
                <CitationBadge key={c.id} citation={c} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
