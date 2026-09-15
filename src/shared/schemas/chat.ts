import { z } from "zod";
import { citationSchema } from "./citation";
import { MAX_OUTLINE_CHAPTERS } from "./book";

/** Who wrote a message in a stored conversation. */
export const chatRoleSchema = z.enum(["user", "assistant"]);

export type ChatRole = z.infer<typeof chatRoleSchema>;

/** A message of the conversation hanging off one highlight. */
export const chatMessageSchema = z.object({
  id: z.string(),
  role: chatRoleSchema,
  content: z.string(),
  // Questions carry none, and answers written before citations existed carry
  // the null the endpoint substitutes for a missing column.
  citations: z.array(citationSchema).nullish(),
  createdAt: z.string(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatHistorySchema = z.object({
  selectionId: z.string(),
  messages: z.array(chatMessageSchema),
});

/** What the reader sends to ask a question about a highlight. */
export const sendChatRequestSchema = z.object({
  content: z.string().min(1),
  // Only a real boolean: the string "false" used to be coerced to true.
  useWebSearch: z.boolean().optional().default(false),
});

export type SendChatRequest = z.infer<typeof sendChatRequestSchema>;

/**
 * A run of pages a question about the book is aimed at.
 *
 * Ranges come from `GET /api/pdf/:pdfId/chapters`, which is where the pages of
 * a chapter are worked out, so the reader picks chapters rather than inventing
 * numbers: a range naming pages the book does not have is clamped when the
 * excerpt is cut, and one entirely outside it is dropped.
 */
export const pageRangeSchema = z
  .object({
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
  })
  .refine((range) => range.endPage >= range.startPage, {
    path: ["endPage"],
    message: "endPage is before startPage",
  });

export type PageRange = z.infer<typeof pageRangeSchema>;

/**
 * How much of the book a question covers. Never empty: the whole book is a
 * range like any other, so there is no second way of saying "everything" and
 * nothing that reads as "no pages at all".
 */
export const chatScopeSchema = z.object({
  ranges: z.array(pageRangeSchema).min(1).max(MAX_OUTLINE_CHAPTERS),
});

export const sendBookChatRequestSchema = sendChatRequestSchema.extend({
  scope: chatScopeSchema,
});

export type SendBookChatRequest = z.infer<typeof sendBookChatRequestSchema>;
