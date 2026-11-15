import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Vite resolves the tsconfig `paths` (@/…) itself; vite-tsconfig-paths is no longer needed (#84).
  resolve: { tsconfigPaths: true },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "evals/**/*.test.ts", "scripts/**/*.test.ts"],
    // Playwright specs live in e2e/ and run with `npm run e2e`.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
