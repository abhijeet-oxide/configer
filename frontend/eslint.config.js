// ESLint flat config: typescript-eslint recommended + React hooks rules.
// tsc --noEmit (strict) already covers types; ESLint focuses on correctness
// hazards (unused code, hook misuse) without stylistic noise.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React-Compiler preview rules are advisory performance guidance, not
      // correctness; the classic rules below stay errors.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // `any` is used deliberately at the API boundary (config values are
      // arbitrary YAML/JSON); the strict tsconfig keeps the rest honest.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
