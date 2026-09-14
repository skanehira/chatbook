/**
 * How a diagram names itself in its fence's info string, as in
 * ```html title="シーケンス図".
 *
 * The quotes are optional: a caption with no space in it reads fine without
 * them, and a model that leaves them off has still named its diagram.
 */
const CAPTION_IN_META = /title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** The caption a fence's info string carries, or null when it names none. */
export function captionFromMeta(meta: string | undefined): string | null {
  const named = meta?.match(CAPTION_IN_META);
  const caption = (named?.[1] ?? named?.[2] ?? named?.[3])?.trim();

  return caption ? caption : null;
}

/**
 * Gives a fence's document a doctype when it arrived without one.
 *
 * Without it the browser lays the popup out in quirks mode, where the widths
 * and heights the diagram's author wrote stop meaning what they say.
 */
export function asStandaloneDocument(html: string): string {
  return /^\s*<!doctype/i.test(html) ? html : `<!doctype html>\n${html}`;
}
