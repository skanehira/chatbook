import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Claude Code keeps its agent worktrees under `.claude/worktrees/`, which are
// whole checkouts of this repo. Without this, `vp check` and `pnpm test` in the
// main clone pick those up and report failures that belong to another branch —
// or collect their Playwright and workers-pool specs into the jsdom run.
const AGENT_WORKTREES = ".claude/**";

export default defineConfig({
  plugins: [react(), tailwindcss(), !process.env.VITEST && cloudflare()],
  fmt: {
    ignorePatterns: [AGENT_WORKTREES],
  },
  lint: {
    ignorePatterns: [AGENT_WORKTREES],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["useEffect"],
              message:
                "useEffect は誤用が多いため禁止。どうしても必要な場合は該当行に oxlint-disable コメントを付けて理由を明記する。",
            },
          ],
        },
      ],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // e2e/ holds Playwright specs, which must not be collected by vitest
    exclude: ["**/node_modules/**", "**/dist/**", "test/worker/**", "e2e/**", AGENT_WORKTREES],
  },
});
