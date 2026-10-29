import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    // Playwright fixtures take a callback named `use` (not a React hook); the stub preload is plain CommonJS.
    files: ["e2e/**"],
    rules: { "react-hooks/rules-of-hooks": "off", "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
