import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import type { ErrorCode } from "../../shared/schemas/error";

/** How each request part is named in the message a rejected request gets back. */
const TARGET_LABEL: Partial<Record<keyof ValidationTargets, string>> = {
  json: "request body",
  param: "path parameter",
  query: "query parameter",
};

/**
 * `zValidator` answering with this API's error envelope.
 *
 * The stock handler replies with zod's own report, which nothing here can
 * read: the client looks for `error.message`, so a rejected request would
 * surface as the generic "request failed with status 400" instead of naming
 * the field at fault.
 *
 * The message lists the offending paths rather than quoting zod's wording, so
 * it stays the same across zod releases.
 */
export function validate<Target extends keyof ValidationTargets, S extends ZodType>(
  target: Target,
  schema: S,
) {
  return zValidator(target, schema, (result, c) => {
    if (result.success) return;

    const fields = [
      ...new Set(
        result.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        ),
      ),
    ];

    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR" satisfies ErrorCode,
          message: `Invalid ${TARGET_LABEL[target] ?? target}: ${fields.join(", ")}`,
        },
      },
      400,
    );
  });
}
