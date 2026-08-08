import { Hono } from "hono";
import type { ErrorCode } from "../shared/schemas/error";
import { healthRoute } from "./routes/health";
import { pdfRoute } from "./routes/pdf";

type Env = {
  Bindings: {
    DB: D1Database;
    PDF_BUCKET: R2Bucket;
    DEEPSEEK_API_KEY: string;
  };
};

/**
 * The API under `/api`, with the two replies no route writes itself.
 *
 * Hono's own defaults answer an unhandled throw and an unknown path in
 * `text/plain`, which is the one shape the client cannot read: `fetcher`
 * reports anything that is not the `{ error: { code, message } }` envelope as
 * `UNKNOWN`, so a D1 outage reached the reader as "something went wrong" with
 * nothing behind it. These two put every reply back inside the envelope.
 *
 * Only `/api/*` reaches the Worker (`run_worker_first` in wrangler.jsonc), so
 * `notFound` here cannot answer for a deep link into the SPA.
 */
const app = new Hono<Env>()
  .basePath("/api")
  .route("/", healthRoute)
  .route("/", pdfRoute)
  .notFound((c) =>
    c.json(
      { error: { code: "ROUTE_NOT_FOUND" satisfies ErrorCode, message: "No such API endpoint" } },
      404,
    ),
  )
  .onError((err, c) => {
    // Last stop for a throw no route expected. What went wrong stays on the
    // server; the client is told only that it was not its request's fault.
    console.error("Unhandled API error:", err);
    return c.json(
      { error: { code: "INTERNAL_ERROR" satisfies ErrorCode, message: "Unexpected server error" } },
      500,
    );
  });

export default app;
