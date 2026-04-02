// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const stateFilePath = "/app/config/update-state.json"

// UpdateStateFile is the persistent state file for blue/green slot management.
type UpdateStateFile struct {
	ActiveSlot      string    `json:"activeSlot"`      // "blue" or "green"
	ActiveVersion   string    `json:"activeVersion"`
	PreviousVersion string    `json:"previousVersion"`
	PreviousSlot    string    `json:"previousSlot"`
	UpdatedAt       time.Time `json:"updatedAt"`
	RollbackAvail   bool      `json:"rollbackAvailable"`
}

// ReadState reads the state file. Returns defaults (blue, no previous) if missing.
func ReadState() (*UpdateStateFile, error) {
	data, err := os.ReadFile(stateFilePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &UpdateStateFile{
				ActiveSlot:    "blue",
				ActiveVersion: "unknown",
				RollbackAvail: false,
			}, nil
		}
		return nil, err
	}

	var state UpdateStateFile
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// WriteState writes the state atomically (temp file + rename).
func WriteState(state *UpdateStateFile) error {
	state.UpdatedAt = time.Now().UTC()

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(stateFilePath)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}

	tmpPath := stateFilePath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o640); err != nil {
		return err
	}

	return os.Rename(tmpPath, stateFilePath)
}

// GetInactiveSlot returns the slot that is NOT currently active.
func GetInactiveSlot(activeSlot string) string {
	if activeSlot == "blue" {
		return "green"
	}
	return "blue"
}
