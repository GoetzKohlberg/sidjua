// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TestMonitorPostSwitch_Healthy_Exits verifies that monitorPostSwitch calls
// exitFunc(0) after all health checks pass for the full monitoring window.
func TestMonitorPostSwitch_Healthy_Exits(t *testing.T) {
	var (
		mu       sync.Mutex
		exitCode = -1
	)
	origExit     := exitFunc
	origWindow   := monitorWindow
	origInterval := monitorCheckInterval
	exitFunc = func(code int) {
		mu.Lock()
		exitCode = code
		mu.Unlock()
	}
	monitorWindow        = 50 * time.Millisecond
	monitorCheckInterval = 1 * time.Millisecond
	defer func() {
		exitFunc             = origExit
		monitorWindow        = origWindow
		monitorCheckInterval = origInterval
	}()

	// Mock health server — always returns 200.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	u := &Updater{}

	done := make(chan struct{})
	go func() {
		defer close(done)
		u.monitorPostSwitch(srv.URL, "", "", "", "", "")
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("monitorPostSwitch did not return within 5s")
	}

	mu.Lock()
	code := exitCode
	mu.Unlock()
	if code != 0 {
		t.Fatalf("expected exitFunc(0), got exitFunc(%d)", code)
	}
}

// TestMonitorPostSwitch_Unhealthy_Rollsback verifies that monitorPostSwitch
// does NOT call exitFunc when the health check fails — it rolls back and returns.
func TestMonitorPostSwitch_Unhealthy_Rollsback(t *testing.T) {
	var (
		mu       sync.Mutex
		exitCode = -1
	)
	origExit     := exitFunc
	origWindow   := monitorWindow
	origInterval := monitorCheckInterval
	exitFunc = func(code int) {
		mu.Lock()
		exitCode = code
		mu.Unlock()
	}
	monitorWindow        = 5 * time.Second
	monitorCheckInterval = 1 * time.Millisecond
	defer func() {
		exitFunc             = origExit
		monitorWindow        = origWindow
		monitorCheckInterval = origInterval
	}()

	// Mock health server — always returns 500 (unhealthy).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	// Old slot server — receives rollback calls; respond 200 best-effort.
	oldSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer oldSrv.Close()

	u := &Updater{}

	done := make(chan struct{})
	go func() {
		defer close(done)
		u.monitorPostSwitch(srv.URL, "old", oldSrv.URL, "", "", "")
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("monitorPostSwitch did not return within 10s after unhealthy response")
	}

	mu.Lock()
	code := exitCode
	mu.Unlock()
	if code != -1 {
		t.Fatalf("exitFunc must NOT be called on rollback path, but got exitFunc(%d)", code)
	}

	u.mu.Lock()
	state := u.state
	u.mu.Unlock()
	if state != StateIdle {
		t.Fatalf("expected state StateIdle after rollback, got %v", state)
	}
}
