import { z } from "zod";

/** The content hash a book's R2 objects are keyed by. */
export const fileHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** One part of an R2 multipart upload, as R2 itself identifies it. */
export const uploadedPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1),
});

export type UploadedPart = z.infer<typeof uploadedPartSchema>;

export const uploadInitRequestSchema = z.object({
  fileHash: fileHashSchema,
});

export const uploadInitResponseSchema = z.object({
  pdfUploadId: z.string().min(1),
});

export const uploadCompleteRequestSchema = z.object({
  fileName: z.string().min(1),
  fileHash: fileHashSchema,
  pageCount: z.number().int().positive(),
  pdfUploadId: z.string().min(1),
  pdfParts: z.array(uploadedPartSchema).min(1),
});

export const textStoredSchema = z.object({ stored: z.literal(true) });
