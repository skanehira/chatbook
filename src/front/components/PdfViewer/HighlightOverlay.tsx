import type { PositionData, SelectionRect } from "../../../shared/schemas/selection";

interface Highlight {
  id: string;
  pageNumber: number;
  /** `pageWidth` is missing on records stored before the viewer could be
   * resized, which were always measured at 1.5x. */
  positionData: PositionData;
  color: string;
}

interface HighlightOverlayProps {
  highlights: Highlight[];
  pageNumber: number;
  containerWidth: number;
  containerHeight: number;
  /** Page width at scale 1, used to reconstruct the width of legacy records. */
  basePageWidth: number;
  /** The passage a question is being written about, not yet saved. */
  pending?: { rects: SelectionRect[]; pageWidth: number } | null;
  onHighlightClick: (selectionId: string) => void;
}

const LEGACY_SCALE = 1.5;

/**
 * Rects are stored in page pixels, so they have to be rescaled whenever the
 * page is rendered at a different width than it was selected at.
 */
function scaleRect(rect: SelectionRect, factor: number) {
  return {
    left: rect.x * factor,
    top: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

export function HighlightOverlay({
  highlights,
  pageNumber,
  containerWidth,
  containerHeight,
  basePageWidth,
  pending,
  onHighlightClick,
}: HighlightOverlayProps) {
  const pageHighlights = highlights.filter((h) => h.pageNumber === pageNumber);
  const scaleTo = (storedWidth: number) => (storedWidth > 0 ? containerWidth / storedWidth : 1);

  return (
    // Sits above the text layer so highlights stay clickable, but the container
    // itself must not swallow pointer events: the text layer underneath needs
    // them for selection. Only the highlights themselves opt back in.
    <div
      className="pointer-events-none absolute top-0 left-0 z-10"
      style={{ width: containerWidth, height: containerHeight }}
    >
      {pageHighlights.map((h) => {
        const factor = scaleTo(h.positionData.pageWidth ?? basePageWidth * LEGACY_SCALE);

        return h.positionData.rects.map((rect, i) => (
          <button
            key={`${h.id}-${i}`}
            type="button"
            aria-label="ハイライトのチャットを開く"
            className="pointer-events-auto absolute opacity-30 cursor-pointer transition-opacity hover:opacity-50"
            style={{ ...scaleRect(rect, factor), backgroundColor: h.color }}
            onClick={(e) => {
              e.stopPropagation();
              onHighlightClick(h.id);
            }}
          />
        ));
      })}

      {/* Focusing the question box clears the browser's own selection, so the
          passage is drawn here to stay visible while the question is written */}
      {pending?.rects.map((rect, i) => (
        <div
          key={`pending-${i}`}
          data-testid="pending-selection"
          aria-hidden="true"
          className="pendingSelection absolute bg-blue-500 opacity-30"
          style={scaleRect(rect, scaleTo(pending.pageWidth))}
        />
      ))}
    </div>
  );
}
