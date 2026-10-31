import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 ships native flat configs (no FlatCompat / @eslint/eslintrc needed).
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    // eslint-plugin-react-hooks 7 (bundled with eslint-config-next 16) adds React Compiler rules. We do not use the
    // compiler; the 6 hits are intentional (elapsed-time refs in plan-runner/places-loader, Date.now() in a Server
    // Component). Kept as warnings so they stay visible; refactor in a separate, browser-tested change.
    rules: { "react-hooks/refs": "warn", "react-hooks/purity": "warn" },
  },
  {
    // Playwright fixtures take a callback named `use` (not a React hook); the stub preload is plain CommonJS.
    files: ["e2e/**"],
    rules: { "react-hooks/rules-of-hooks": "off", "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
