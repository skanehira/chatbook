import { describe, it, expect } from "vite-plus/test";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";

describe("GET /api/health", () => {
  it("returns ok once the D1 migration has been applied", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const response = await exports.default.fetch("https://example.com/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
