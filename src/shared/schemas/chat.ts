import { z } from "zod";
import { citationSchema } from "./citation";

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
