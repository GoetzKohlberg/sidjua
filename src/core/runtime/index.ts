// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

export { DeadWorkerRecovery }         from "./dead-worker-recovery.js";
export type { DeadWorkerRecoveryConfig } from "./dead-worker-recovery.js";
export { BackpressureManager, BackpressureError } from "./backpressure.js";
export type { BackpressureConfig }    from "./backpressure.js";
export {
  installImmutableAuditTriggers,
  verifyImmutableAuditTriggers,
}                                     from "./sqlite-audit-immutable.js";
