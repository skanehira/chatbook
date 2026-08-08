import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine, so it ships no scrollIntoView. Components that
// keep a conversation pinned to the bottom would throw on mount without it.
Element.prototype.scrollIntoView = () => {};

// pdf.js constructs a DOMMatrix at module scope, which jsdom does not provide.
// jsdom tests never rasterize a page, so anything that can be constructed is
// enough to let modules that transitively import pdf.js load.
if (!("DOMMatrix" in globalThis)) {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class {};
}
