// oxlint-disable-next-line no-restricted-imports -- document への keydown / mousedown 購読 (Escape と外側クリックで閉じる) に必要
import { useState, useRef, useEffect } from "react";
import { isSubmitKey } from "../../lib/isSubmitKey";

interface SelectionPopoverProps {
  /**
   * Asks the question. Awaited, so the popover can hold the reader off until
   * the ask has been dealt with: it stays open when the highlight could not be
   * stored, and a popover that stays open is one that can be submitted twice.
   */
  onSubmit: (question: string) => void | Promise<void>;
  onDismiss: () => void;
}

/**
 * Question input shown above the selected text. The caller positions it; this
 * component only owns the input, submit and dismiss behaviour.
 */
export function SelectionPopover({ onSubmit, onDismiss }: SelectionPopoverProps) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  // Dismiss on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Delay to avoid dismissing on the same mouseup that triggered this
    setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onDismiss]);

  const handleSubmit = async () => {
    const q = question.trim();
    // One ask at a time. Both routes in (the button and Enter) come through
    // here, so this is the only gate needed.
    if (!q || asking) return;

    setAsking(true);
    try {
      await onSubmit(q);
    } catch {
      // Reporting is the asker's job — it owns the message and where it shows.
      // Swallowing here only stops a rejection escaping an event handler,
      // where nothing (not even the route's errorElement) would catch it.
    } finally {
      // A successful ask unmounts this popover, so this only ever puts a
      // failed one back within reach of the reader.
      setAsking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isSubmitKey(e.nativeEvent as unknown as KeyboardEvent)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      ref={popoverRef}
      className="relative bg-white rounded-lg shadow-xl border border-gray-200 p-3"
    >
      <div
        className="absolute left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-b border-r border-gray-200 rotate-45"
        style={{ top: "calc(100% - 6px)" }}
      />
      <textarea
        ref={inputRef}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="選択した文章について質問する..."
        readOnly={asking}
        className="w-full min-w-[280px] p-2 text-sm border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent read-only:bg-gray-50"
        rows={2}
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onDismiss}
          className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!question.trim() || asking}
          className="px-3 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {asking ? "送信中..." : "質問する"}
        </button>
      </div>
    </div>
  );
}
