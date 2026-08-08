import { useSetAtom } from "jotai";
import type { Citation } from "../../../shared/schemas/citation";
import { currentPageAtom } from "../../atoms/pdfAtom";

interface CitationBadgeProps {
  citation: Citation;
}

const BADGE_CLASS = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium";

export function CitationBadge({ citation }: CitationBadgeProps) {
  const setCurrentPage = useSetAtom(currentPageAtom);

  if (citation.type === "web" && citation.url) {
    return (
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        title={citation.url}
        className={`${BADGE_CLASS} bg-green-100 text-green-700 transition-colors hover:bg-green-200`}
      >
        [{citation.id}] 🔗
      </a>
    );
  }

  const pageNumber = citation.pageNumber;
  // Without a page there is nowhere to jump to, so the badge is not a control
  if (!pageNumber) {
    return (
      <span title={citation.text} className={`${BADGE_CLASS} bg-gray-100 text-gray-500`}>
        [{citation.id}]
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={`出典 [${citation.id}] のページへ移動`}
      onClick={() => setCurrentPage(pageNumber)}
      title={citation.text}
      className={`${BADGE_CLASS} cursor-pointer bg-yellow-100 text-yellow-700 transition-colors hover:bg-yellow-200`}
    >
      [{citation.id}] p.{citation.pageNumber}
    </button>
  );
}
