import { z } from "zod";
import { selectionHighlightSchema } from "./selection";

/** A book as the shelf shows it. */
export const bookSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  pageCount: z.number().int().positive(),
  updatedAt: z.string(),
  hasThumbnail: z.boolean(),
});

export type BookSummary = z.infer<typeof bookSummarySchema>;

export const bookListSchema = z.object({ books: z.array(bookSummarySchema) });

/**
 * Where the reader left off, as every device that opens the book gets it.
 *
 * The four travel together because they were saved together: the page, the
 * chat that was open on it, and whether the outline and the chat pane sat
 * beside them. `null` for either panel is "no wide screen has said either way"
 * — narrow screens do not save them, since there the outline is a drawer and
 * the chat a sheet over the page rather than places next to it.
 */
export const readingStateSchema = z.object({
  page: z.number().int().positive(),
  selectionId: z.string().nullable(),
  outlineOpen: z.boolean().nullable(),
  chatPanelOpen: z.boolean().nullable(),
});

export type ReadingState = z.infer<typeof readingStateSchema>;

/**
 * What a device sends to save its place. The two panels are optional rather
 * than nullable: leaving them out keeps whatever was stored, which is how a
 * narrow screen saves a page without folding away what a wide screen opened.
 */
export const saveReadingStateRequestSchema = z.object({
  page: z.number().int().positive(),
  selectionId: z.string().nullable(),
  outlineOpen: z.boolean().optional(),
  chatPanelOpen: z.boolean().optional(),
});

export type SaveReadingStateRequest = z.infer<typeof saveReadingStateRequestSchema>;

export const readingStateSavedSchema = z.object({ saved: z.literal(true) });

/** What opening a PDF returns: the metadata the reader needs to render it. */
export const pdfMetadataSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  pageCount: z.number().int().positive(),
  fullText: z.string().optional(),
  // Carried here too: the picker seeds the cache from this answer, and a seed
  // without the place would open an already-read book at page 1.
  readingState: readingStateSchema.nullable(),
});

export type PdfMetadata = z.infer<typeof pdfMetadataSchema>;

/** A book with the highlights made in it. */
export const bookDetailSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  pageCount: z.number().int().positive(),
  hasThumbnail: z.boolean(),
  selections: z.array(selectionHighlightSchema),
  readingState: readingStateSchema.nullable(),
});

export type BookDetail = z.infer<typeof bookDetailSchema>;

/**
 * Longest passage `/locate` will look for. A quoted passage is a sentence or
 * two; beyond this the request is not a lookup, and each one scans the whole
 * book character by character.
 */
export const MAX_LOCATE_TEXT_LENGTH = 2000;

export const locateQuerySchema = z.object({
  text: z.string().min(1).max(MAX_LOCATE_TEXT_LENGTH),
});

/**
 * Why a quoted passage has no page. Each one is a different thing to tell the
 * reader: a quote that is nowhere in the book is a sign the model reworded it,
 * while a book of one page simply has nowhere to jump to.
 */
export const pageMissSchema = z.enum(["no-quote", "not-in-book", "single-page-book"]);

export type PageMiss = z.infer<typeof pageMissSchema>;

/** Where a passage quoted from a `#:~:text=` link lives, or why it has no page. */
export const locatedPageSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), pageNumber: z.number().int().positive() }),
  z.object({ found: z.literal(false), miss: pageMissSchema }),
]);

export type LocatedPage = z.infer<typeof locatedPageSchema>;

export const bookDeletedSchema = z.object({ deleted: z.literal(true) });

export const thumbnailStoredSchema = z.object({ stored: z.literal(true) });
