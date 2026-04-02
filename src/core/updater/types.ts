// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

export interface VersionInfo {
  current:         string;
  latest:          string;
  updateAvailable: boolean;
  releaseNotes:    string;
  size:            number;   // MB
  breaking:        boolean;  // major version bump
  minUpgradeFrom:  string;
}

export interface UpdateStatus {
  state: "idle" | "pulling" | "freezing" | "locking" | "starting" | "healthcheck" | "switching" | "resuming" | "draining" | "stopping" | "rolling_back";
  progress:        number;        // 0-100
  activeSlot:      "blue" | "green";
  activeVersion:   string;
  previousVersion?: string;
}

export interface SlotInfo {
  slot:    "blue" | "green";
  version: string;
  healthy: boolean;
}

export interface HealthResponse {
  version:            string;
  healthy:            boolean;
  db_read:            boolean;
  db_write:           boolean;
  disk_ok:            boolean;
  migration_complete: boolean;
  qdrant_connected:   boolean;
}
