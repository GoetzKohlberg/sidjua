// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * ESLint flat config — SIDJUA
 *
 * NOTE: ESLint is not yet in devDependencies (P430 / #775 — pending Opus approval).
 * This file is ready to use once `eslint` is installed.
 *
 * Custom rules:
 *   sidjua/no-raw-tempdir  — ban raw mkdtemp/os.tmpdir in test files
 *   sidjua/error-style     — enforce consistent error message phrasing
 *   sidjua/import-order    — enforce canonical import ordering
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const noRawTempdir = require("./tools/eslint-rules/no-raw-tempdir.js");
const errorStyle   = require("./tools/lint/error-style.js");
const importOrder  = require("./tools/lint/import-order.js");

/** @type {import('eslint').Linter.Config[]} */
export default [
  // -------------------------------------------------------------------------
  // Global ignores
  // -------------------------------------------------------------------------
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".tmp-tests/**",
      "coverage/**",
      "sidjua-gui/**",
    ],
  },

  // -------------------------------------------------------------------------
  // Test files — ban raw mkdtemp / os.tmpdir
  // -------------------------------------------------------------------------
  {
    files: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    plugins: {
      sidjua: {
        rules: {
          "no-raw-tempdir": noRawTempdir,
          "error-style":    errorStyle,
          "import-order":   importOrder,
        },
      },
    },
    rules: {
      "sidjua/no-raw-tempdir": "error",
    },
  },

  // -------------------------------------------------------------------------
  // Source files — style rules only
  // -------------------------------------------------------------------------
  {
    files: ["src/**/*.ts"],
    plugins: {
      sidjua: {
        rules: {
          "error-style":  errorStyle,
          "import-order": importOrder,
        },
      },
    },
    rules: {
      "sidjua/error-style":  "warn",
      "sidjua/import-order": "warn",
    },
  },
];
