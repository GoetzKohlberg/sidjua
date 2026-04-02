// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

// Package main implements the SIDJUA blue/green update sidecar.
// HTTP server on port 8090 with endpoints for update orchestration.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const sidecarVersion = "1.0"

// UpdateState enumerates the phases of the update sequence.
type UpdateState string

const (
	StateIdle        UpdateState = "idle"
	StatePulling     UpdateState = "pulling"
	StateFreezing    UpdateState = "freezing"
	StateLocking     UpdateState = "locking"
	StateStarting    UpdateState = "starting"
	StateHealthcheck UpdateState = "healthcheck"
	StateSwitching   UpdateState = "switching"
	StateResuming    UpdateState = "resuming"
	StateDraining    UpdateState = "draining"
	StateStopping    UpdateState = "stopping"
	StateRollingBack UpdateState = "rolling_back"
)

// HistoryEntry records a completed update for the /history endpoint.
type HistoryEntry struct {
	Version   string    `json:"version"`
	Timestamp time.Time `json:"timestamp"`
	Success   bool      `json:"success"`
	Duration  string    `json:"duration"`
	Slot      string    `json:"slot"`
}

// Updater holds the sidecar's mutable runtime state.
type Updater struct {
	mu              sync.Mutex
	state           UpdateState
	progress        int
	activeSlot      string
	activeVersion   string
	previousVersion string
	history         []HistoryEntry
}

func newUpdater() *Updater {
	state, err := ReadState()
	activeSlot    := "blue"
	activeVersion := "unknown"
	if err == nil && state != nil {
		activeSlot    = state.ActiveSlot
		activeVersion = state.ActiveVersion
	}
	return &Updater{
		state:         StateIdle,
		activeSlot:    activeSlot,
		activeVersion: activeVersion,
	}
}

func main() {
	u := newUpdater()
	mux := http.NewServeMux()

	mux.HandleFunc("/health",   u.handleHealth)
	mux.HandleFunc("/status",   u.handleStatus)
	mux.HandleFunc("/update",   u.handleUpdate)
	mux.HandleFunc("/rollback", u.handleRollback)
	mux.HandleFunc("/history",  u.handleHistory)

	srv := &http.Server{
		Addr:         ":8090",
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0, // SSE endpoints stream indefinitely
		IdleTimeout:  60 * time.Second,
	}

	fmt.Println("SIDJUA updater sidecar starting on :8090")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("server error: %v\n", err)
	}
}

func (u *Updater) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"healthy":        true,
		"sidecarVersion": sidecarVersion,
	})
}

func (u *Updater) handleStatus(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	resp := map[string]interface{}{
		"state":           u.state,
		"progress":        u.progress,
		"activeSlot":      u.activeSlot,
		"activeVersion":   u.activeVersion,
		"previousVersion": u.previousVersion,
	}
	u.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (u *Updater) handleHistory(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	history := make([]HistoryEntry, len(u.history))
	copy(history, u.history)
	u.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

func (u *Updater) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Reject if already running
	u.mu.Lock()
	if u.state != StateIdle {
		u.mu.Unlock()
		http.Error(w, `{"error":"update already in progress"}`, http.StatusConflict)
		return
	}
	u.state = StatePulling
	u.mu.Unlock()

	var req struct {
		TargetVersion string `json:"targetVersion"`
	}
	body, _ := io.ReadAll(r.Body)
	if err := json.Unmarshal(body, &req); err != nil || req.TargetVersion == "" {
		u.mu.Lock()
		u.state = StateIdle
		u.mu.Unlock()
		http.Error(w, `{"error":"targetVersion required"}`, http.StatusBadRequest)
		return
	}

	// SSE response
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, canFlush := w.(http.Flusher)

	events := make(chan ProgressEvent, 20)
	start := time.Now()

	go func() {
		err := u.RunUpdate(req.TargetVersion, events)
		if err != nil {
			events <- ProgressEvent{State: StateIdle, Error: err.Error()}
		}
		close(events)

		u.mu.Lock()
		success := err == nil
		u.history = append(u.history, HistoryEntry{
			Version:   req.TargetVersion,
			Timestamp: time.Now().UTC(),
			Success:   success,
			Duration:  time.Since(start).String(),
			Slot:      u.activeSlot,
		})
		if success {
			state, _ := ReadState()
			if state != nil {
				u.activeSlot      = state.ActiveSlot
				u.activeVersion   = state.ActiveVersion
				u.previousVersion = state.PreviousVersion
			}
		}
		u.state = StateIdle
		u.mu.Unlock()
	}()

	for event := range events {
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if canFlush {
			flusher.Flush()
		}
	}
}

func (u *Updater) handleRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u.mu.Lock()
	if u.state != StateIdle {
		u.mu.Unlock()
		http.Error(w, `{"error":"operation already in progress"}`, http.StatusConflict)
		return
	}
	u.state = StateRollingBack
	u.mu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, canFlush := w.(http.Flusher)

	events := make(chan ProgressEvent, 10)
	start := time.Now()

	go func() {
		err := u.RunRollback(events)
		if err != nil {
			events <- ProgressEvent{State: StateIdle, Error: err.Error()}
		}
		close(events)

		u.mu.Lock()
		u.history = append(u.history, HistoryEntry{
			Version:   "rollback",
			Timestamp: time.Now().UTC(),
			Success:   err == nil,
			Duration:  time.Since(start).String(),
			Slot:      u.activeSlot,
		})
		u.state = StateIdle
		u.mu.Unlock()
	}()

	for event := range events {
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if canFlush {
			flusher.Flush()
		}
	}
}
