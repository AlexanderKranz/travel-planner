import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}", "evals/**/*.test.ts", "scripts/**/*.test.ts"],
    // Playwright specs live in e2e/ and run with `npm run e2e`.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
