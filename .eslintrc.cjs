module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint", "solid"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:solid/typescript",
  ],
  ignorePatterns: ["dist", "node_modules", "src-tauri", "target"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

    // Native dialogs are dead in Tauri's WKWebView: a `confirm()` or
    // `prompt()` silently does nothing, so a delete confirmation would never
    // appear and the destructive action would either never fire or fire
    // unconfirmed. Every confirmation and text input is an app-rendered
    // component. See PRD Risks and Правки of the Pane project (commit 81dc73e).
    "no-restricted-globals": [
      "error",
      { name: "confirm", message: "Мёртв в Tauri WKWebView — своя модалка." },
      { name: "prompt", message: "Мёртв в Tauri WKWebView — inline-форма." },
      { name: "alert", message: "Мёртв в Tauri WKWebView — свой компонент." },
    ],
  },
};
