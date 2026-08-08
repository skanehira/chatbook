export interface SelectionPosition {
  startIndex: number;
  endIndex: number;
  pageNumber: number;
  rects: { x: number; y: number; width: number; height: number }[];
}

/** The passage the reader dragged over, located in the page's text items. */
export interface SelectionFromTextLayer {
  text: string;
  startIndex: number;
  endIndex: number;
  pageNumber: number;
}

/**
 * Get the text item indices from the current Selection.
 * Returns null if the selection is empty or not within our text layer.
 */
export function getSelectionFromTextLayer(): SelectionFromTextLayer | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  // Find the text layer container (ancestor with text layer spans)
  const container = range.commonAncestorContainer;
  const textLayer = findTextLayerContainer(container);
  if (!textLayer) return null;

  // Get all spans within the selection range
  const spans = textLayer.querySelectorAll("span[data-text-item-index]");
  if (spans.length === 0) return null;

  // Find start and end indices
  const selectionSpans = getSelectedSpans(range, Array.from(spans) as HTMLElement[]);
  if (selectionSpans.length === 0) return null;

  const startIndex = parseInt(selectionSpans[0].dataset.textItemIndex!, 10);
  const endIndex = parseInt(selectionSpans[selectionSpans.length - 1].dataset.textItemIndex!, 10);
  const pageNumber = parseInt(selectionSpans[0].dataset.pageNumber!, 10);

  return {
    text,
    startIndex,
    endIndex,
    pageNumber,
  };
}

function findTextLayerContainer(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.querySelector("span[data-text-item-index]")) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getSelectedSpans(range: Range, allSpans: HTMLElement[]): HTMLElement[] {
  const selected: HTMLElement[] = [];
  for (const span of allSpans) {
    if (range.intersectsNode(span)) {
      selected.push(span);
    }
  }
  return selected;
}
