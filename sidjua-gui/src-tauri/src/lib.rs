// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

//! SIDJUA Desktop — Tauri backend
//!
//! Exposes a minimal set of IPC commands for security-sensitive operations.
//! All commands enforce that the target server URL resolves to a loopback
//! address (127.0.0.1 / localhost / ::1) — remote connections are rejected.
//!
//! Commands:
//!   reveal_secret      — GET /api/v1/secrets/:name/value
//!   create_token       — POST /api/v1/tokens
//!   shutdown_server    — POST /api/v1/system/shutdown
//!
//! The frontend invokes these via @tauri-apps/api invoke() instead of calling
//! the REST API directly.  This ensures:
//!   1. Sensitive API calls are gated through Tauri's IPC (not raw fetch).
//!   2. The Rust backend enforces localhost-only constraints.
//!   3. Token / secret handling never touches the renderer process beyond
//!      what is strictly returned to the caller.

use tauri::State;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/// Shared HTTP client — created once and reused for all command invocations.
pub struct ApiClientState {
    pub client: Mutex<reqwest::Client>,
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/// Return Ok if `url` points to a loopback address, Err otherwise.
/// Only http:// and https:// schemes pointing to 127.0.0.1, localhost, or ::1
/// are permitted.  Any other host (including 0.0.0.0) is rejected.
fn validate_localhost(url: &str) -> Result<(), String> {
    let allowed_prefixes = [
        "http://127.0.0.1",
        "https://127.0.0.1",
        "http://localhost",
        "https://localhost",
        "http://[::1]",
        "https://[::1]",
    ];
    if allowed_prefixes.iter().any(|prefix| url.starts_with(prefix)) {
        Ok(())
    } else {
        Err(format!(
            "Only localhost connections are allowed. Got: {}",
            url
        ))
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Reveal the plaintext value of a named secret.
/// Calls GET /api/v1/secrets/:name/value with Bearer auth.
#[tauri::command]
pub async fn reveal_secret(
    name: String,
    server_url: String,
    token: String,
    state: State<'_, ApiClientState>,
) -> Result<String, String> {
    validate_localhost(&server_url)?;
    let url = format!(
        "{}/api/v1/secrets/{}/value",
        server_url.trim_end_matches('/'),
        name
    );
    let client = state.client.lock().map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(body["value"].as_str().unwrap_or("").to_string())
}

/// Create a scoped API token.
/// Calls POST /api/v1/tokens with Bearer auth; returns the raw token string.
#[tauri::command]
pub async fn create_token(
    scope: String,
    label: String,
    server_url: String,
    token: String,
    state: State<'_, ApiClientState>,
) -> Result<String, String> {
    validate_localhost(&server_url)?;
    let url = format!("{}/api/v1/tokens", server_url.trim_end_matches('/'));
    let client = state.client.lock().map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "scope": scope, "label": label }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(body["rawToken"].as_str().unwrap_or("").to_string())
}

/// Request the SIDJUA server to shut down.
/// Calls POST /api/v1/system/shutdown with Bearer auth.
#[tauri::command]
pub async fn shutdown_server(
    server_url: String,
    token: String,
    state: State<'_, ApiClientState>,
) -> Result<(), String> {
    validate_localhost(&server_url)?;
    let url = format!(
        "{}/api/v1/system/shutdown",
        server_url.trim_end_matches('/')
    );
    let client = state.client.lock().map_err(|e| e.to_string())?;
    client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(ApiClientState {
            client: Mutex::new(
                reqwest::Client::builder()
                    .build()
                    .expect("Failed to build HTTP client"),
            ),
        })
        .invoke_handler(tauri::generate_handler![
            reveal_secret,
            create_token,
            shutdown_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
