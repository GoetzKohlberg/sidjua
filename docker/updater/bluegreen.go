// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ProgressEvent is sent over SSE to the caller during an update or rollback.
type ProgressEvent struct {
	State   UpdateState `json:"state"`
	Message string      `json:"message"`
	Step    int         `json:"step"`    // 1-11
	Total   int         `json:"total"`
	Error   string      `json:"error,omitempty"`
}

// pullBackoff intervals for docker pull retries.
var pullBackoff = []time.Duration{10 * time.Second, 30 * time.Second, 90 * time.Second}

// RunUpdate executes the full blue/green update sequence.
// Steps follow the mandatory order from the architecture specification.
func (u *Updater) RunUpdate(targetVersion string, events chan<- ProgressEvent) error {
	state, err := ReadState()
	if err != nil {
		return fmt.Errorf("read state: %w", err)
	}

	activeSlot   := state.ActiveSlot
	inactiveSlot := GetInactiveSlot(activeSlot)
	registry     := os.Getenv("REGISTRY")
	project      := os.Getenv("SIDJUA_COMPOSE_PROJECT")
	if project == "" {
		project = "sidjua"
	}
	caddyAdmin := os.Getenv("CADDY_ADMIN")
	if caddyAdmin == "" {
		caddyAdmin = "http://proxy:2019"
	}
	newImage       := registry + "/sidjua:" + targetVersion
	newContainerName := project + "_sidjua_" + inactiveSlot

	send := func(st UpdateState, msg string, step int) {
		events <- ProgressEvent{State: st, Message: msg, Step: step, Total: 11}
	}

	// ── Step 1: Pre-flight ───────────────────────────────────────────────
	send(StatePulling, "Pre-flight check: verifying disk space and update path", 1)
	if err := checkDiskSpace(); err != nil {
		return fmt.Errorf("pre-flight: %w", err)
	}

	// ── Step 2: Pull new image ────────────────────────────────────────────
	send(StatePulling, "Pulling "+newImage, 2)
	if err := pullWithRetry(newImage); err != nil {
		return fmt.Errorf("pull: %w", err)
	}

	// ── Step 3: SQLite backup ─────────────────────────────────────────────
	send(StateFreezing, "Creating database backup", 3)
	backupPath := "/app/config/.update-backup-" + targetVersion + ".sqlite"
	_ = backupPath // backup created inside container via exec; best-effort
	_ = exec.Command("docker", "exec", project+"_sidjua_"+activeSlot,
		"cp", "/app/data/sidjua.db", backupPath).Run()

	// ── Step 4: Freeze agents on active slot ─────────────────────────────
	send(StateFreezing, "Requesting agent freeze on "+activeSlot+" slot", 4)
	activeBase := "http://sidjua_" + activeSlot + ":4200"
	if err := postJSON(activeBase+"/api/v1/system/freeze", nil, 10*time.Second); err != nil {
		return fmt.Errorf("freeze: %w", err)
	}
	if err := pollUntilFrozen(activeBase, 60*time.Second); err != nil {
		return fmt.Errorf("wait for freeze: %w", err)
	}

	// ── Step 5: Write-lock ────────────────────────────────────────────────
	send(StateLocking, "Enabling write-lock on "+activeSlot+" slot", 5)
	if err := postJSON(activeBase+"/api/v1/update/prepare", nil, 10*time.Second); err != nil {
		return fmt.Errorf("write-lock: %w", err)
	}
	time.Sleep(3 * time.Second) // allow in-flight writes to drain

	// ── Step 6: Start new container ──────────────────────────────────────
	send(StateStarting, "Starting "+inactiveSlot+" slot ("+newImage+")", 6)
	if err := startNewContainer(newContainerName, newImage, inactiveSlot, activeSlot, project); err != nil {
		// Rollback: cancel write-lock, resume active slot
		_ = postJSON(activeBase+"/api/v1/update/cancel", nil, 5*time.Second)
		_ = postJSON(activeBase+"/api/v1/system/resume", nil, 5*time.Second)
		return fmt.Errorf("start new container: %w", err)
	}

	// ── Step 7: Healthcheck new slot ─────────────────────────────────────
	send(StateHealthcheck, "Waiting for "+inactiveSlot+" slot to be healthy", 7)
	newBase := "http://sidjua_" + inactiveSlot + ":4200"
	if err := pollUntilHealthy(newBase, 120*time.Second); err != nil {
		_ = exec.Command("docker", "stop", newContainerName).Run()
		_ = exec.Command("docker", "rm", newContainerName).Run()
		_ = postJSON(activeBase+"/api/v1/update/cancel", nil, 5*time.Second)
		_ = postJSON(activeBase+"/api/v1/system/resume", nil, 5*time.Second)
		return fmt.Errorf("new slot unhealthy: %w", err)
	}

	// ── Step 8: Proxy switch ──────────────────────────────────────────────
	send(StateSwitching, "Switching proxy to "+inactiveSlot+" slot", 8)
	if err := SwitchToSlot(caddyAdmin, "sidjua_"+inactiveSlot); err != nil {
		// Rollback: switch back, stop new container
		_ = SwitchToSlot(caddyAdmin, "sidjua_"+activeSlot)
		_ = exec.Command("docker", "stop", newContainerName).Run()
		_ = exec.Command("docker", "rm", newContainerName).Run()
		_ = postJSON(activeBase+"/api/v1/update/cancel", nil, 5*time.Second)
		_ = postJSON(activeBase+"/api/v1/system/resume", nil, 5*time.Second)
		return fmt.Errorf("caddy switch: %w", err)
	}

	// ── Step 9: Resume agents on new slot ────────────────────────────────
	send(StateResuming, "Resuming agents on "+inactiveSlot+" slot", 9)
	_ = postJSON(newBase+"/api/v1/system/resume", nil, 10*time.Second)

	// ── Step 10: Drain old slot ───────────────────────────────────────────
	send(StateDraining, "Draining "+activeSlot+" slot", 10)
	_ = postJSON(activeBase+"/api/v1/drain", nil, 10*time.Second)
	time.Sleep(30 * time.Second)
	_ = exec.Command("docker", "stop", project+"_sidjua_"+activeSlot).Run()
	_ = exec.Command("docker", "rm", project+"_sidjua_"+activeSlot).Run()

	// ── Step 11: Finalize ─────────────────────────────────────────────────
	send(StateStopping, "Finalizing update", 11)
	newState := &UpdateStateFile{
		ActiveSlot:      inactiveSlot,
		ActiveVersion:   targetVersion,
		PreviousSlot:    activeSlot,
		PreviousVersion: state.ActiveVersion,
		RollbackAvail:   true,
	}
	_ = WriteState(newState)

	// Start post-switch health monitor goroutine (auto-rollback)
	go u.monitorPostSwitch(newBase, activeSlot, activeBase, caddyAdmin, project, newContainerName)

	events <- ProgressEvent{State: StateIdle, Message: "Update to " + targetVersion + " complete", Step: 11, Total: 11}
	return nil
}

// monitorPostSwitch watches the new slot for 60s and auto-rolls back on failure.
func (u *Updater) monitorPostSwitch(newBase, oldSlot, oldBase, caddyAdmin, project, newContainerName string) {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Second)
		resp, err := http.Get(newBase + "/api/v1/health")
		if err != nil || resp.StatusCode != http.StatusOK {
			// Auto-rollback
			u.mu.Lock()
			u.state = StateRollingBack
			u.mu.Unlock()
			_ = SwitchToSlot(caddyAdmin, "sidjua_"+oldSlot)
			_ = exec.Command("docker", "stop", newContainerName).Run()
			_ = exec.Command("docker", "rm", newContainerName).Run()
			_ = postJSON(oldBase+"/api/v1/update/cancel", nil, 5*time.Second)
			_ = postJSON(oldBase+"/api/v1/system/resume", nil, 5*time.Second)
			u.mu.Lock()
			u.state = StateIdle
			u.mu.Unlock()
			return
		}
		if resp != nil {
			resp.Body.Close()
		}
	}
}

// RunRollback switches the proxy back to the previous slot.
func (u *Updater) RunRollback(events chan<- ProgressEvent) error {
	state, err := ReadState()
	if err != nil {
		return fmt.Errorf("read state: %w", err)
	}
	if !state.RollbackAvail {
		return fmt.Errorf("no rollback available")
	}

	caddyAdmin := os.Getenv("CADDY_ADMIN")
	if caddyAdmin == "" {
		caddyAdmin = "http://proxy:2019"
	}

	events <- ProgressEvent{State: StateRollingBack, Message: "Switching proxy back to " + state.PreviousSlot, Step: 1, Total: 2}

	if err := SwitchToSlot(caddyAdmin, "sidjua_"+state.PreviousSlot); err != nil {
		return fmt.Errorf("rollback caddy switch: %w", err)
	}

	newState := &UpdateStateFile{
		ActiveSlot:      state.PreviousSlot,
		ActiveVersion:   state.PreviousVersion,
		PreviousSlot:    state.ActiveSlot,
		PreviousVersion: state.ActiveVersion,
		RollbackAvail:   false,
	}
	_ = WriteState(newState)

	events <- ProgressEvent{State: StateIdle, Message: "Rollback to " + state.PreviousVersion + " complete", Step: 2, Total: 2}
	return nil
}

// pullWithRetry retries docker pull with exponential backoff.
func pullWithRetry(image string) error {
	var lastErr error
	for i, wait := range pullBackoff {
		cmd := exec.Command("docker", "pull", image)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			lastErr = err
			if i < len(pullBackoff)-1 {
				time.Sleep(wait)
			}
			continue
		}
		return nil
	}
	return fmt.Errorf("docker pull failed after %d attempts: %w", len(pullBackoff), lastErr)
}

// startNewContainer creates and starts the new slot container, copying config from active slot.
func startNewContainer(containerName, image, inactiveSlot, activeSlot, project string) error {
	// Get volume mounts and network from active container via inspect
	activeContainer := project + "_sidjua_" + activeSlot
	out, err := exec.Command("docker", "inspect", "--format",
		`{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}`,
		activeContainer).Output()
	if err != nil {
		return fmt.Errorf("inspect active container: %w", err)
	}

	args := []string{
		"run", "-d",
		"--name", containerName,
		"--network", project + "_sidjua-net",
		"--env", "INSTANCE_SLOT=" + inactiveSlot,
		"--env", "NODE_ENV=production",
		"--env", "SIDJUA_PORT=4200",
	}

	// Add volume mounts from active container
	mounts := strings.Fields(strings.TrimSpace(string(out)))
	for _, m := range mounts {
		args = append(args, "-v", m)
	}
	args = append(args, image)

	cmd := exec.Command("docker", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// pollUntilFrozen polls the system state endpoint until FROZEN or timeout.
func pollUntilFrozen(base string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client   := &http.Client{Timeout: 5 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/api/v1/system/state")
		if err == nil && resp.StatusCode == http.StatusOK {
			var body struct {
				State string `json:"state"`
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			_ = json.Unmarshal(data, &body)
			if body.State == "FROZEN" {
				return nil
			}
		}
		time.Sleep(3 * time.Second)
	}
	return fmt.Errorf("timed out waiting for FROZEN state after %s", timeout)
}

// pollUntilHealthy polls the health endpoint until all fields are true or timeout.
func pollUntilHealthy(base string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client   := &http.Client{Timeout: 5 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/api/v1/health")
		if err == nil && resp.StatusCode == http.StatusOK {
			var health struct {
				Healthy           bool `json:"healthy"`
				MigrationComplete bool `json:"migration_complete"`
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			_ = json.Unmarshal(data, &health)
			if health.Healthy && health.MigrationComplete {
				return nil
			}
		}
		time.Sleep(5 * time.Second)
	}
	return fmt.Errorf("timed out waiting for healthy state after %s", timeout)
}

// checkDiskSpace verifies at least 500MB free in /app.
func checkDiskSpace() error {
	out, err := exec.Command("df", "-m", "/app").Output()
	if err != nil {
		return nil // non-fatal if df unavailable
	}
	lines := strings.Split(string(out), "\n")
	if len(lines) < 2 {
		return nil
	}
	var fields []string
	for _, f := range strings.Fields(lines[1]) {
		fields = append(fields, f)
	}
	if len(fields) < 4 {
		return nil
	}
	var free int64
	fmt.Sscanf(fields[3], "%d", &free)
	if free < 500 {
		return fmt.Errorf("insufficient disk space: %dMB free, need 500MB", free)
	}
	return nil
}

// postJSON sends a POST request with optional JSON body.
func postJSON(url string, body interface{}, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(http.MethodPost, url, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return nil
}
