// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * GATE-L3 — repo-state sanity checks run before every test suite.
 *
 * Checks (exits 1 on first failure):
 *   1. package.json version matches strict SemVer (x.y.z or x.y.z-rc.N)
 *   2. CHANGELOG.md contains a [version] entry (skipped for rc builds)
 *   3. .build-meta version == package.json version (skipped if file absent)
 *   4. Working tree clean (only when CI=true)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();

function pass(msg) {
  console.log(`[GATE-L3] PASS: ${msg}`);
}

function fail(msg) {
  console.error(`[GATE-L3] FAIL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 1: Version sanity
// ---------------------------------------------------------------------------
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
} catch (e) {
  fail(`cannot read package.json: ${e.message}`);
}

const version = pkg.version;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$/;

if (!SEMVER_RE.test(version)) {
  fail(`package.json version '${version}' is not valid SemVer (expected x.y.z or x.y.z-rc.N)`);
}
pass(`version=${version}`);

// ---------------------------------------------------------------------------
// Check 2: CHANGELOG sync (skip for rc builds)
// ---------------------------------------------------------------------------
const isRc = version.includes('-rc.');

if (!isRc) {
  const changelogPath = join(ROOT, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    fail(`CHANGELOG.md not found — expected [${version}] entry`);
  }
  const changelog = readFileSync(changelogPath, 'utf-8');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryRe = new RegExp(`\\[${escapedVersion}\\]`, 'i');
  if (!entryRe.test(changelog)) {
    fail(`CHANGELOG.md has no [${version}] entry`);
  }
  pass(`CHANGELOG contains [${version}]`);
} else {
  pass(`version is RC (${version}) — CHANGELOG check skipped`);
}

// ---------------------------------------------------------------------------
// Check 3: .build-meta sync (only when file exists)
// ---------------------------------------------------------------------------
const buildMetaPath = join(ROOT, '.build-meta');
if (existsSync(buildMetaPath)) {
  let meta;
  try {
    meta = JSON.parse(readFileSync(buildMetaPath, 'utf-8'));
  } catch (e) {
    fail(`.build-meta is not valid JSON: ${e.message}`);
  }
  if (meta.version !== version) {
    fail(`.build-meta version '${meta.version}' != package.json version '${version}'`);
  }
  pass(`.build-meta version matches (${meta.version})`);
} else {
  pass('.build-meta not present — skipped');
}

// ---------------------------------------------------------------------------
// Check 4: Working tree clean (CI=true only)
// ---------------------------------------------------------------------------
if (process.env.CI === 'true') {
  let dirty;
  try {
    dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch (e) {
    fail(`git status failed: ${e.message}`);
  }
  if (dirty) {
    fail(`working tree is dirty (CI=true requires clean tree):\n${dirty}`);
  }
  pass('working tree clean (CI=true)');
} else {
  pass('working tree check skipped (CI not set)');
}

// ---------------------------------------------------------------------------
// Check 5: no hardcoded current-version literals outside canonical sources
//          (SPEC-RELEASE-PIPELINE-V1 §6.5 — Version String Single-Source-of-Truth)
// ---------------------------------------------------------------------------
// Pattern matches only the CURRENT package.json version in double or single quotes.
// Excludes src/version.ts (canonical definition) and lines annotated with
// "// version-literal-ok" (rare intentional exceptions).
try {
  const cmdDQ = `grep -rn --include='*.ts' -F '"${version}"' tests/ src/ 2>/dev/null | grep -v 'src/version.ts' | grep -v '// version-literal-ok' || true`;
  const cmdSQ = `grep -rn --include='*.ts' -F "'${version}'" tests/ src/ 2>/dev/null | grep -v 'src/version.ts' | grep -v '// version-literal-ok' || true`;
  const outDQ = execSync(cmdDQ, { cwd: ROOT, encoding: 'utf-8' }).trim();
  const outSQ = execSync(cmdSQ, { cwd: ROOT, encoding: 'utf-8' }).trim();
  const output = [outDQ, outSQ].filter(Boolean).join('\n');
  if (output) {
    console.error(`[GATE-L3] FAIL: hardcoded version literals found (SPEC §6.5 violation):\n${output}`);
    console.error('  Import SIDJUA_VERSION from src/version.ts instead.');
    console.error('  For rare exceptions: suffix the line with // version-literal-ok');
    process.exit(1);
  }
  pass('no hardcoded version literals (SPEC §6.5)');
} catch (e) {
  fail(`hardcoded-version scan failed: ${e.message}`);
}
