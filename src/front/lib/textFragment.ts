/**
 * URL text fragments (`#:~:text=…`) — the format Chrome's "Copy link to
 * highlight" produces.
 *
 * The browser resolves these itself on a normal page, but here the passage
 * lives in a PDF page that is only rendered once the reader jumps to it, so the
 * app has to read the fragment and do the jump.
 *
 * Spec: https://wicg.github.io/scroll-to-text-fragment/
 */
const FRAGMENT_DIRECTIVE = ":~:";
const TEXT_DIRECTIVE = "text=";

/**
 * The passage a text fragment points at, or null if the hash has none.
 *
 * A fragment may carry context words (`prefix-,passage,-suffix`) and a range
 * end (`start,end`); the start of the match is what identifies the page.
 */
export function parseTextFragment(hash: string): string | null {
  const directiveIndex = hash.indexOf(FRAGMENT_DIRECTIVE);
  if (directiveIndex < 0) return null;

  const directive = hash.slice(directiveIndex + FRAGMENT_DIRECTIVE.length);
  const textDirective = directive
    .split("&")
    .find((part) => part.startsWith(TEXT_DIRECTIVE))
    ?.slice(TEXT_DIRECTIVE.length);
  if (!textDirective) return null;

  const parts = textDirective.split(",");
  if (parts.length > 1 && parts[0].endsWith("-")) parts.shift();
  if (parts.length > 1 && parts[parts.length - 1].startsWith("-")) parts.pop();

  const start = decodeURIComponent(parts[0]);
  return start || null;
}

/**
 * The passage of the text fragment the page was opened with.
 *
 * The browser strips the fragment directive from `location.hash` before scripts
 * can see it (that is what the spec asks for), so the URL has to be recovered
 * from the navigation timing entry, which keeps what was actually requested.
 *
 * Pass `performance.getEntriesByType("navigation")`.
 */
export function passageFromNavigation(entries: { name: string }[]): string | null {
  const url = entries[0]?.name;
  if (!url) return null;

  try {
    return parseTextFragment(new URL(url).hash);
  } catch {
    // The entry's name is whatever the browser recorded. One it cannot parse
    // means this page was not opened from a link to a passage, which is the
    // ordinary case, not a failure.
    return null;
  }
}
