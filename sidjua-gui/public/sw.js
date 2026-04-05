// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.
'use strict';

// Service worker is intentionally a no-op.
// Caching is disabled to ensure consistent behaviour when served over
// file:// (Tauri) and to avoid stale-asset issues during updates.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
