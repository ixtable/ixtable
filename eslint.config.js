import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import noBannedClassSelectorRule from "./eslint-rules/no-banned-class-selector.js";
import noDocumentDispatchEventRule from "./eslint-rules/no-document-dispatch-event.js";
import noInlineCommentsRule from "./eslint-rules/no-inline-comments.js";
import noUnusedExportedTsFunctionsRule from "./eslint-rules/no-unused-exported-ts-functions.js";
import noUnusedPubRustFunctionsRule from "./eslint-rules/no-unused-pub-rust-functions.js";
import preferClickByQueryRule from "./eslint-rules/prefer-click-by-query.js";
import preferFindByTextRule from "./eslint-rules/prefer-find-by-text.js";
import requireTauriApiCommandWrappersRule from "./eslint-rules/require-tauri-api-command-wrappers.js";
import requireTauriApiExportsUsedRule from "./eslint-rules/require-tauri-api-exports-used.js";
import userEventSetupInSetupRule from "./eslint-rules/user-event-setup-in-setup.js";

const localRules = {
  "no-banned-class-selector": noBannedClassSelectorRule,
  "no-document-dispatch-event": noDocumentDispatchEventRule,
  "no-inline-comments": noInlineCommentsRule,
  "no-unused-exported-ts-functions": noUnusedExportedTsFunctionsRule,
  "no-unused-pub-rust-functions": noUnusedPubRustFunctionsRule,
  "prefer-click-by-query": preferClickByQueryRule,
  "prefer-find-by-text": preferFindByTextRule,
  "require-tauri-api-command-wrappers": requireTauriApiCommandWrappersRule,
  "require-tauri-api-exports-used": requireTauriApiExportsUsedRule,
  "user-event-setup-in-setup": userEventSetupInSetupRule,
};

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/.docusaurus/**",
    "**/.generated/**",
    "src-tauri/resources/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      local: { rules: localRules },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}"],
    rules: {
      "local/no-unused-exported-ts-functions": "warn",
    },
  },
  {
    files: ["src/lib/api.ts"],
    rules: {
      "local/no-unused-pub-rust-functions": "warn",
      "local/require-tauri-api-command-wrappers": "warn",
      "local/require-tauri-api-exports-used": "warn",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "web/e2e/**/*.{ts,tsx}"],
    rules: {
      "local/no-banned-class-selector": "warn",
      "local/no-document-dispatch-event": "warn",
      "local/no-inline-comments": "warn",
      "local/prefer-click-by-query": "warn",
      "local/prefer-find-by-text": "warn",
      "local/user-event-setup-in-setup": "warn",
    },
  },
  {
    files: ["**/*.{jsx,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    plugins: {
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
]);
