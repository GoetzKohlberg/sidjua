"use strict";
/**
 * tools/eslint-rules/no-raw-tempdir.js
 *
 * Custom ESLint rule: ban raw mkdtemp / os.tmpdir() in test files.
 *
 * Enforced in: tests/**\/*.test.ts, tests/**\/*.spec.ts
 *
 * DISALLOWED:
 *   import { mkdtemp, mkdtempSync } from 'node:fs'
 *   import { mkdtemp, mkdtempSync } from 'node:fs/promises'
 *   import { mkdtemp, mkdtempSync } from 'fs'
 *   import { tmpdir } from 'node:os'
 *   import { tmpdir } from 'os'
 *   import * as os from 'node:os'  +  os.tmpdir() call
 *   require('node:os').tmpdir()
 *   require('fs').mkdtempSync(...)
 *   require('node:fs/promises').mkdtemp(...)
 *
 * ALLOWED:
 *   import { ... } from 'tests/_helpers/temp-dir'
 *   import { ... } from '../_helpers/temp-dir'
 *   (any import whose specifier contains '_helpers/temp-dir')
 *
 * Error message references P430 / #775 for context.
 *
 * Wiring (eslint.config.js / .eslintrc.js):
 *   The rule is registered as 'sidjua/no-raw-tempdir'.
 *   See eslint.config.js in the repo root for the active configuration.
 *   NOTE: requires eslint ^9 as a devDependency — pending Opus approval (#775).
 */

const FORBIDDEN_FS_SPECIFIERS  = new Set(["fs", "node:fs", "node:fs/promises"]);
const FORBIDDEN_OS_SPECIFIERS  = new Set(["os", "node:os"]);
const FORBIDDEN_FS_NAMES       = new Set(["mkdtemp", "mkdtempSync"]);
const HELPER_PATH_FRAGMENT     = "_helpers/temp-dir";

const MSG_IMPORT = "Use withTempDir/useTempDir from tests/_helpers/temp-dir instead of raw mkdtemp/os.tmpdir. See #775 / P430 for context.";
const MSG_CALL   = "Use withTempDir/useTempDir from tests/_helpers/temp-dir instead of raw os.tmpdir(). See #775 / P430 for context.";

/** @type {import('eslint').Rule.RuleModule} */
const noRawTempdir = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw mkdtemp/os.tmpdir in test files — use tests/_helpers/temp-dir",
      category:    "Best Practices",
    },
    schema: [],
    messages: {
      forbidden: MSG_IMPORT,
      forbiddenCall: MSG_CALL,
    },
  },

  create(context) {
    const filename = context.getFilename();

    // Only enforce inside test files.
    if (!/tests[\\/].*\.(test|spec)\.ts$/.test(filename)) {
      return {};
    }

    // Track namespace imports of os: `import * as os from 'node:os'`
    const osNamespaceIdentifiers = new Set();

    return {
      // -----------------------------------------------------------------------
      // Named imports: import { mkdtemp } from 'node:fs/promises'
      //                import { tmpdir }  from 'node:os'
      // -----------------------------------------------------------------------
      ImportDeclaration(node) {
        const src = node.source.value;

        // Allow the helper itself.
        if (typeof src === "string" && src.includes(HELPER_PATH_FRAGMENT)) {
          return;
        }

        if (typeof src === "string" && FORBIDDEN_FS_SPECIFIERS.has(src)) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              FORBIDDEN_FS_NAMES.has(specifier.imported.name)
            ) {
              context.report({ node: specifier, messageId: "forbidden" });
            }
          }
        }

        if (typeof src === "string" && FORBIDDEN_OS_SPECIFIERS.has(src)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportSpecifier" && specifier.imported.name === "tmpdir") {
              context.report({ node: specifier, messageId: "forbidden" });
            }
            // Namespace import: import * as os from 'node:os'
            if (specifier.type === "ImportNamespaceSpecifier") {
              osNamespaceIdentifiers.add(specifier.local.name);
            }
          }
        }
      },

      // -----------------------------------------------------------------------
      // Namespace call: os.tmpdir()
      // -----------------------------------------------------------------------
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          osNamespaceIdentifiers.has(node.callee.object.name) &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "tmpdir"
        ) {
          context.report({ node, messageId: "forbiddenCall" });
        }

        // require('node:os').tmpdir() — dynamic require pattern
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "CallExpression" &&
          node.callee.object.callee.type === "Identifier" &&
          node.callee.object.callee.name === "require" &&
          node.callee.object.arguments.length === 1 &&
          typeof node.callee.object.arguments[0].value === "string"
        ) {
          const requiredModule = node.callee.object.arguments[0].value;
          const prop = node.callee.property.name;

          if (FORBIDDEN_OS_SPECIFIERS.has(requiredModule) && prop === "tmpdir") {
            context.report({ node, messageId: "forbiddenCall" });
          }

          if (FORBIDDEN_FS_SPECIFIERS.has(requiredModule) && FORBIDDEN_FS_NAMES.has(prop)) {
            context.report({ node, messageId: "forbidden" });
          }
        }
      },
    };
  },
};

module.exports = noRawTempdir;
