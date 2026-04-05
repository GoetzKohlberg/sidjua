// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * TLS certificate generation and HTTPS server helpers.
 *
 * Generates self-signed X.509 certificates via the system `openssl` binary
 * (no npm dependencies).  Provides typed config for HTTPS listener setup.
 */

import { execFileSync }                               from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join }                             from "node:path";
import { tmpdir }                                    from "node:os";
import { randomBytes }                               from "node:crypto";


export interface TlsConfig {
  enabled:        boolean;
  cert:           string;            // path to PEM certificate
  key:            string;            // path to PEM private key
  redirect_http?: boolean | undefined; // redirect plain HTTP to HTTPS (default false)
  http_port?:     number | undefined;  // port for the HTTP→HTTPS redirect listener
}

export interface TlsGenerateOptions {
  certPath:    string;
  keyPath:     string;
  hostname?:   string;  // additional SAN hostname (default: localhost)
  validDays?:  number;  // certificate validity (default: 365)
}


/**
 * Generate a self-signed X.509 certificate using the system `openssl` CLI.
 *
 * @param opts  Output paths, optional hostname SAN, and validity period.
 * @throws      If `openssl` is not available or certificate generation fails.
 */
export function generateSelfSignedCert(opts: TlsGenerateOptions): void {
  const {
    certPath,
    keyPath,
    hostname  = "localhost",
    validDays = 365,
  } = opts;

  // Validate hostname before injecting into OpenSSL config content.
  // Only alphanumeric, dots, and hyphens are safe in a SAN DNS value.
  if (hostname !== "localhost") {
    if (hostname.length > 253) {
      throw new Error(`Hostname too long for TLS certificate: ${hostname.length} chars (max 253)`);
    }
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
      throw new Error(
        `Invalid hostname for TLS certificate: "${hostname}". ` +
        "Only alphanumeric characters, dots, and hyphens are allowed.",
      );
    }
  }

  // Ensure output directories exist
  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath),  { recursive: true });

  // Write a temporary OpenSSL config to include SANs (more portable than -addext)
  const tmpDir    = tmpdir();
  const cfgFile   = join(tmpDir, `sidjua-tls-${randomBytes(4).toString("hex")}.cfg`);
  const sanDns    = hostname !== "localhost" ? `,DNS:${hostname}` : "";
  const cfgContent = [
    "[req]",
    "distinguished_name = req_dn",
    "x509_extensions    = v3_req",
    "prompt             = no",
    "",
    "[req_dn]",
    "CN = SIDJUA Management Console",
    "O  = SIDJUA",
    "",
    "[v3_req]",
    "subjectAltName = IP:127.0.0.1,DNS:localhost" + sanDns,
    "keyUsage       = digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
  ].join("\n");

  writeFileSync(cfgFile, cfgContent, "utf-8");

  try {
    execFileSync("openssl", [
      "req", "-x509",
      "-newkey", "rsa:2048",
      "-nodes",
      "-keyout", keyPath,
      "-out",    certPath,
      "-days",   String(validDays),
      "-config", cfgFile,
    ], { stdio: "pipe" });
  } finally {
    // Clean up temp config file (best-effort)
    try { unlinkSync(cfgFile); } catch (_e) { /* ignore temp config cleanup failure */ }
  }
}


/**
 * Resolve TLS config from environment variables, falling back to defaults.
 *
 * Priority: ENV > provided default
 *
 * ENV vars:
 *   SIDJUA_TLS_ENABLED  = "true" | "false"
 *   SIDJUA_TLS_CERT     = /path/to/cert.pem
 *   SIDJUA_TLS_KEY      = /path/to/key.pem
 */
export function resolveTlsConfig(defaults: TlsConfig): TlsConfig {
  const envEnabled = process.env["SIDJUA_TLS_ENABLED"];
  const envCert    = process.env["SIDJUA_TLS_CERT"];
  const envKey     = process.env["SIDJUA_TLS_KEY"];

  return {
    enabled:       envEnabled !== undefined ? envEnabled === "true" : defaults.enabled,
    cert:          envCert    ?? defaults.cert,
    key:           envKey     ?? defaults.key,
    ...(defaults.redirect_http !== undefined ? { redirect_http: defaults.redirect_http } : {}),
    ...(defaults.http_port     !== undefined ? { http_port:     defaults.http_port     } : {}),
  };
}

/** Default TLS configuration (disabled, standard paths). */
export const DEFAULT_TLS_CONFIG: TlsConfig = {
  enabled:       false,
  cert:          "/etc/sidjua/tls/cert.pem",
  key:           "/etc/sidjua/tls/key.pem",
  redirect_http: false,
  http_port:     3080,
};

/**
 * Return true if TLS appears to be configured and both files exist on disk.
 * Does NOT verify that the cert/key form a valid pair.
 */
export function tlsFilesExist(cfg: TlsConfig): boolean {
  return existsSync(cfg.cert) && existsSync(cfg.key);
}
