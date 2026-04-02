// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * @deprecated Import from "../../core/network/url-validator.js" instead.
 *
 * This module is a compatibility shim. The canonical implementations of
 * validateOutboundUrl() and validateSshHost() now live in the unified
 * url-validator module alongside validateProviderUrl().
 */

export { validateOutboundUrl, validateOutboundUrlAsync, validateSshHost } from "./network/url-validator.js";
