module.exports = {
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
    "plugin:import/recommended",
    "@electron-toolkit/eslint-config-ts/recommended",
    "plugin:prettier/recommended",
  ],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "prettier/prettier": [
      "error",
      {
        endOfLine: "auto",
      },
    ],
    "no-console": ["error", { allow: ["warn", "error"] }],
    "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
    "no-warning-comments": [
      "error",
      {
        terms: ["todo", "fixme", "xxx", "hack"],
        location: "start",
      },
    ],
    "import/no-default-export": "error",
    "import/no-unresolved": "off",
    "import/named": "off",
    "import/no-named-as-default": "off",
    "import/no-named-as-default-member": "off",
  },
  overrides: [
    {
      files: ["src/renderer/src/**/*.tsx"],
      rules: { "import/no-default-export": "off" },
    },
    {
      files: ["src/renderer/src/main.tsx"],
      rules: { "no-console": "off" },
    },
    {
      files: ["scripts/**/*.cjs"],
      rules: { "no-console": "off" },
    },
    {
      files: ["**/*.d.ts"],
      rules: { "import/no-default-export": "off" },
    },
    {
      files: ["src/locales/index.ts"],
      rules: { "import/no-default-export": "off" },
    },
    {
      files: ["*.config.js", "*.config.ts", "*.config.cjs"],
      rules: { "import/no-default-export": "off" },
    },
  ],
  settings: {
    react: {
      version: "detect",
    },
  },
};
