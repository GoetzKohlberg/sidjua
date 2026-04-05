// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Content-Type Validation Middleware
 *
 * Ensures that POST/PUT/PATCH requests with a body declare
 * `Content-Type: application/json` (or the charset variant).
 *
 * Returns HTTP 415 (Unsupported Media Type) when the header is absent
 * or declares a non-JSON type, preventing parser inconsistencies and
 * unintended form-data or plain-text body processing.
 *
 * Exemptions:
 *   - GET / HEAD / DELETE / OPTIONS — no body expected
 *   - Requests with Content-Length: 0 (empty-body POSTs)
 *
 * Missing or empty Content-Type on a body-carrying request is rejected (415).
 */

import type { MiddlewareHandler } from "hono";

// Methods that carry a body and therefore must declare Content-Type.
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Validate that body-carrying requests declare a JSON Content-Type.
 */
export const contentTypeJson: MiddlewareHandler = async (c, next) => {
  if (!BODY_METHODS.has(c.req.method.toUpperCase())) {
    return next();
  }

  // Skip if there is provably no body (Content-Length: 0).
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && parseInt(contentLength, 10) === 0) {
    return next();
  }

  const contentType = c.req.header("content-type") ?? "";
  const mediaType   = contentType.split(";")[0]!.trim().toLowerCase();

  if (mediaType !== "application/json" && mediaType !== "multipart/form-data") {
    const displayed = mediaType === "" ? "(missing)" : `"${mediaType}"`;
    return c.json(
      {
        error: {
          code:        "INPUT-005",
          message:     `Unsupported Media Type: ${displayed}. Expected application/json.`,
          recoverable: false,
        },
      },
      415,
    );
  }

  return next();
};
