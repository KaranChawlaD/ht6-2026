import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist/**",
    "node_modules/**",
    "build/**",
    "examples/**",
    "worker/**",
    ".sites-runtime/**",
    ".wrangler/**",
    ".vinext/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
]);
