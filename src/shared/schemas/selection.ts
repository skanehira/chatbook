import { z } from "zod";

/** One line of a highlight, in the page's own pixels. */
export const selectionRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type SelectionRect = z.infer<typeof selectionRectSchema>;

/**
 * The stored geometry of a highlight, and the only shape the viewer draws from.
 *
 * Unknown keys are stripped rather than rejected: the viewer sends its whole
 * measurement object (which also carries the text offsets it used to find the
 * passage), and rows written before this shape existed carry those extras too.
 */
export const positionDataSchema = z.object({
  rects: z.array(selectionRectSchema),
  /** Page width the rects were measured at, so they can be rescaled later.
   * Missing on records stored before the viewer could be resized. */
  pageWidth: z.number().positive().optional(),
});

export type PositionData = z.infer<typeof positionDataSchema>;

/** A highlight of the open book, as the viewer draws it and the list shows it. */
export const selectionHighlightSchema = z.object({
  id: z.string(),
  selectedText: z.string(),
  pageNumber: z.number().int().positive(),
  positionData: positionDataSchema,
  color: z.string(),
  createdAt: z.string(),
});

export type SelectionHighlight = z.infer<typeof selectionHighlightSchema>;

/** What the viewer sends when the reader highlights a passage. */
export const createSelectionRequestSchema = z.object({
  selectedText: z.string().min(1),
  pageNumber: z.number().int().positive(),
  positionData: positionDataSchema,
});

export type CreateSelectionRequest = z.infer<typeof createSelectionRequestSchema>;

/** The highlight as it comes back from its own creation, before it has a colour. */
export const createdSelectionSchema = z.object({
  id: z.string(),
  selectedText: z.string(),
  pageNumber: z.number().int().positive(),
  positionData: positionDataSchema,
  createdAt: z.string(),
});

export type CreatedSelection = z.infer<typeof createdSelectionSchema>;

export const selectionDeletedSchema = z.object({ deleted: z.literal(true) });
