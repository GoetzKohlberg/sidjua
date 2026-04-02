// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// caddyConfig builds the full Caddy JSON config for routing to the given slot.
func caddyConfig(slotName string) map[string]interface{} {
	return map[string]interface{}{
		"apps": map[string]interface{}{
			"http": map[string]interface{}{
				"servers": map[string]interface{}{
					"srv0": map[string]interface{}{
						"listen": []string{":3000"},
						"routes": []interface{}{
							map[string]interface{}{
								"handle": []interface{}{
									map[string]interface{}{
										"handler": "reverse_proxy",
										"upstreams": []interface{}{
											map[string]interface{}{
												"dial": slotName + ":4200",
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	}
}

// SwitchToSlot pushes a full Caddy config to route traffic to the given slot.
// Retries once on failure before returning an error.
func SwitchToSlot(caddyAdmin string, slotName string) error {
	cfg := caddyConfig(slotName)
	body, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal caddy config: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := caddyAdmin + "/load"

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("create caddy request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("caddy admin request failed: %w", err)
			time.Sleep(2 * time.Second)
			continue
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)

		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("caddy returned HTTP %d", resp.StatusCode)
			time.Sleep(2 * time.Second)
			continue
		}
		return nil
	}
	return lastErr
}
