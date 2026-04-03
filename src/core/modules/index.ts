// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

export type { ModuleDefinition, InstalledModule }      from "./types.js";
export { scanModules }                                  from "./module-scanner.js";
export { installModule, removeModule, deriveModuleName } from "./module-installer.js";
export { scaffoldModule }                               from "./module-scaffolder.js";
export type { ScaffoldResult }                          from "./module-scaffolder.js";
export type { InstallResult }                           from "./module-installer.js";
export {
  moduleToMcpConfig,
  mergeGovernanceOverrides,
  buildModuleConfigMap,
}                                                       from "./module-registry-bridge.js";
