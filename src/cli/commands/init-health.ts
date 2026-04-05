// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — init welcome banner
 *
 * Extracted from init.ts: post-init workspace welcome display.
 */

import { SIDJUA_VERSION } from "../../version.js";


export function printWelcomeBanner(workDir: string): void {
  process.stdout.write(`
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   SIDJUA v${SIDJUA_VERSION} — Your AI Team, Your Rules               │
│                                                          │
│   Workspace created at: ${workDir.slice(0, 32).padEnd(32)}   │
│   Guide agent ready — no configuration needed.           │
│                                                          │
│   Start talking:                                         │
│     sidjua chat guide                                    │
│                                                          │
│   Next steps:                                            │
│     • Add a free API key:  /key groq <your-key>          │
│     • Create your first agent: just ask the Guide        │
│     • Full docs: docs/QUICK-START.md                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
`);
}
