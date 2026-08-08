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

/** What opening a PDF returns: the metadata the reader needs to render it. */
export const pdfMetadataSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  pageCount: z.number().int().positive(),
  fullText: z.string(),
});

export type PdfMetadata = z.infer<typeof pdfMetadataSchema>;

/** A book with the highlights made in it. */
export const bookDetailSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  pageCount: z.number().int().positive(),
  hasThumbnail: z.boolean(),
  selections: z.array(selectionHighlightSchema),
});

export type BookDetail = z.infer<typeof bookDetailSchema>;

/** Where a passage quoted from a `#:~:text=` link lives, or null if nowhere. */
export const locatedPageSchema = z.object({
  pageNumber: z.number().int().positive().nullable(),
});

export const bookDeletedSchema = z.object({ deleted: z.literal(true) });

export const thumbnailStoredSchema = z.object({ stored: z.literal(true) });
