import type { Citation } from "../../shared/schemas/citation";

export type { Citation } from "../../shared/schemas/citation";

/**
 * A turn as the LLM is given it. Not the stored `ChatMessage`: this one also
 * carries the `system` turn, which is built per request and never persisted.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Build the messages array for the DeepSeek API call.
 */
export function buildMessages(
  systemPrompt: string,
  history: { role: string; content: string }[],
  userMessage: string,
): LlmMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];
}

/** pdfLoader が fullText に埋めるページ区切り。 */
const PAGE_DELIMITER = "\f";

/**
 * Whitespace is where the quote and the extracted text diverge: pdf.js joins
 * text items with spaces, while the model quotes the passage as it reads.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * Length of the fragments used when a quote does not appear verbatim, and how
 * far apart they start. Long enough to be unique in a book, short enough to
 * survive the model rewording a clause.
 */
const FRAGMENT_LENGTH = 24;
const FRAGMENT_STEP = 12;

/** The page whose text contains the needle, or -1. */
function pageContaining(normalizedPages: string[], needle: string): number {
  return normalizedPages.findIndex((page) => page.includes(needle));
}

/**
 * Page number for a quoted passage, found by searching each page's text.
 *
 * The model rarely reproduces a passage character for character, so a failed
 * whole-quote match falls back to fragments of it. Falls back further to a
 * position ratio for records stored before the extractor delimited pages.
 */
export function findPageNumber(
  text: string,
  fullText: string,
  pageCount: number,
): number | undefined {
  const needle = normalize(text);
  if (pageCount <= 1 || !needle) return undefined;

  const pages = fullText.split(PAGE_DELIMITER);
  if (pages.length <= 1) {
    const idx = normalize(fullText).indexOf(needle);
    if (idx < 0) return undefined;
    const pageSize = normalize(fullText).length / pageCount;
    return Math.min(pageCount, Math.floor(idx / pageSize) + 1);
  }

  const normalizedPages = pages.map(normalize);
  const onOnePage = pageContaining(normalizedPages, needle);
  if (onOnePage >= 0) return onOnePage + 1;

  // A quote can start near the bottom of a page and finish on the next one
  for (let i = 0; i < normalizedPages.length - 1; i++) {
    if ((normalizedPages[i] + normalizedPages[i + 1]).includes(needle)) return i + 1;
  }

  // Scan fragments from the start of the quote, so the first hit is the page
  // the passage begins on
  for (let start = 0; start + FRAGMENT_LENGTH <= needle.length; start += FRAGMENT_STEP) {
    const page = pageContaining(normalizedPages, needle.slice(start, start + FRAGMENT_LENGTH));
    if (page >= 0) return page + 1;
  }

  return undefined;
}

/**
 * Text inside the outermost quotation marks of a Sources entry.
 * The model writes `「passage」（本書 第1章）`, so the trailing note has to be
 * dropped before the passage can be looked up in the document.
 */
function extractQuotedText(entry: string): string {
  const quoted = entry.match(/[「"“']([\s\S]+)[」"”']/);
  return quoted ? quoted[1] : entry;
}

/**
 * Parse citations from the AI response text.
 * Looks for "## Sources" section and extracts [n] entries.
 * For PDF citations, finds the page number by searching the full text.
 */
export function parseCitations(
  responseText: string,
  fullText?: string,
  pageCount?: number,
): Citation[] {
  const citations: Citation[] = [];

  // Find "## Sources" section
  const sourcesMatch = responseText.match(/## Sources\n([\s\S]*)$/);
  if (!sourcesMatch) return citations;

  const sourcesText = sourcesMatch[1];
  const lines = sourcesText.split("\n");

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (!match) continue;

    const id = match[1];
    const content = match[2].trim();

    // Check if it's a web citation (contains URL)
    const urlMatch = content.match(/^(.+?)\s*-\s*(https?:\/\/\S+)$/);
    if (urlMatch) {
      citations.push({
        id,
        type: "web",
        text: urlMatch[1].replace(/^"|"$/g, ""),
        url: urlMatch[2],
      });
    } else {
      // PDF citation - extract quoted text and find page number
      const quotedText = extractQuotedText(content);
      const pageNumber =
        fullText && pageCount ? findPageNumber(quotedText, fullText, pageCount) : undefined;

      citations.push({
        id,
        type: "pdf",
        text: quotedText,
        pageNumber,
      });
    }
  }

  return citations;
}
