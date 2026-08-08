import { z } from "zod";

/**
 * A source the assistant named in its `## Sources` section. PDF citations carry
 * the page the passage was found on; web citations carry the page's URL.
 */
export const citationSchema = z.object({
  id: z.string(),
  type: z.enum(["pdf", "web"]),
  text: z.string(),
  pageNumber: z.number().int().positive().optional(),
  url: z.string().optional(),
});

export type Citation = z.infer<typeof citationSchema>;
