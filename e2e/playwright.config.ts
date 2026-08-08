import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// worktree ごとに専用ポートを割り当てる。5173 固定だと別クローンの dev サーバーに
// 誤接続したまま「成功」しうるため、リポジトリのパスから決定的に導出する。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathHash = createHash("sha256").update(projectRoot).digest().readUInt16BE(0);
const port = Number(process.env.E2E_PORT ?? 5175 + (pathHash % 500));

export default defineConfig({
  testDir: "./",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    command: `pnpm run db:migrate:local && vp dev --port ${port} --strictPort`,
    port,
    timeout: 120000,
    reuseExistingServer: false,
    cwd: "../",
  },
});
