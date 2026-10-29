import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/** Live evals only (spec 7): `npm run evals:live`. Never part of `npm test`. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["evals/live.eval.ts", "evals/group-text.eval.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
    silent: false,
  },
});
