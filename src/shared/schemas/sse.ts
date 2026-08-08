import { z } from "zod";
import { citationSchema } from "./citation";
import { errorPayloadSchema } from "./error";

export const chatTokenSchema = z.object({ content: z.string() });

export const chatDoneSchema = z.object({
  messageId: z.string(),
  // Absent when the upstream stream ended without reporting its token counts.
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

/**
 * The events the answer stream is made of.
 *
 * The event name is the discriminator, so a failure travels here as a bare
 * `{ code, message }` rather than the `{ error: … }` envelope an HTTP response
 * body uses — there is nothing to disambiguate it from.
 */
export const chatSseEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("token"), data: chatTokenSchema }),
  z.object({ event: z.literal("citation"), data: citationSchema }),
  z.object({ event: z.literal("done"), data: chatDoneSchema }),
  z.object({ event: z.literal("error"), data: errorPayloadSchema }),
]);

export type ChatSseEvent = z.infer<typeof chatSseEventSchema>;
