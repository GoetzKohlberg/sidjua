// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Filesystem adapter — path-validated CRUD operations.
 * All paths are checked against allowed_paths/blocked_paths before I/O.
 */

import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import type {
  ToolAdapter,
  ToolAction,
  ToolCapability,
  ToolResult,
  ToolType,
  FilesystemToolConfig,
} from "../types.js";


export class FilesystemAdapter implements ToolAdapter {
  readonly id: string;
  readonly type: ToolType = "filesystem";

  private readonly config: FilesystemToolConfig;
  private readonly capabilities: ToolCapability[];

  /** Normalized allowed_paths (absolute). */
  private readonly allowedPaths: string[];
  /** Normalized blocked_paths (absolute). */
  private readonly blockedPaths: string[];

  constructor(id: string, config: FilesystemToolConfig, capabilities: ToolCapability[]) {
    this.id = id;
    this.config = config;
    this.capabilities = capabilities;

    this.allowedPaths = config.allowed_paths.map((p) => path.resolve(p));
    this.blockedPaths = (config.blocked_paths ?? []).map((p) => path.resolve(p));
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    // No-op — filesystem is always available
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(action: ToolAction): Promise<ToolResult> {
    const start = Date.now();

    const filePath = String(action.params["path"] ?? "");

    try {
      switch (action.capability) {
        case "read_file":
          return await this.readFile(filePath, start);

        case "write_file":
          return await this.writeFile(
            filePath,
            String(action.params["content"] ?? ""),
            start
          );

        case "list_dir":
          return await this.listDir(filePath, start);

        case "delete_file":
          return await this.deleteFile(filePath, start);

        case "create_dir":
          return await this.createDir(filePath, start);

        case "stat":
          return await this.statPath(filePath, start);

        default:
          return {
            success: false,
            error: `Unknown filesystem capability: ${action.capability}`,
            duration_ms: Date.now() - start,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  }

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    // Filesystem is always available
    return true;
  }

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    // No-op
  }

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------

  getCapabilities(): ToolCapability[] {
    return this.capabilities;
  }

  // -------------------------------------------------------------------------
  // Private capability implementations
  // -------------------------------------------------------------------------

  private async readFile(filePath: string, start: number): Promise<ToolResult> {
    this.validatePath(filePath);
    const content = await fs.readFile(filePath, "utf8");
    return {
      success: true,
      data: content,
      duration_ms: Date.now() - start,
    };
  }

  private async writeFile(
    filePath: string,
    content: string,
    start: number
  ): Promise<ToolResult> {
    if (this.config.read_only === true) {
      throw new Error("Read-only filesystem");
    }
    this.validatePath(filePath);
    await fs.writeFile(filePath, content);
    return {
      success: true,
      duration_ms: Date.now() - start,
    };
  }

  private async listDir(filePath: string, start: number): Promise<ToolResult> {
    this.validatePath(filePath);
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    const data = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }));
    return {
      success: true,
      data,
      duration_ms: Date.now() - start,
    };
  }

  private async deleteFile(filePath: string, start: number): Promise<ToolResult> {
    if (this.config.read_only === true) {
      throw new Error("Read-only filesystem");
    }
    this.validatePath(filePath);
    await fs.unlink(filePath);
    return {
      success: true,
      duration_ms: Date.now() - start,
    };
  }

  private async createDir(filePath: string, start: number): Promise<ToolResult> {
    if (this.config.read_only === true) {
      throw new Error("Read-only filesystem");
    }
    this.validatePath(filePath);
    await fs.mkdir(filePath, { recursive: true });
    return {
      success: true,
      duration_ms: Date.now() - start,
    };
  }

  private async statPath(filePath: string, start: number): Promise<ToolResult> {
    this.validatePath(filePath);
    const stats = await fs.stat(filePath);
    return {
      success: true,
      data: {
        size: stats.size,
        mtime: stats.mtime,
        isDirectory: stats.isDirectory(),
      },
      duration_ms: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // Path validation
  // -------------------------------------------------------------------------

  /**
   * Resolve and validate a file path against the configured allow/block lists.
   *
   * Throws if:
   * - The resolved path starts with any blocked_path
   * - The resolved path does NOT start with any allowed_path
   * - A symlink is broken (realpathSync throws on a non-existent path chain)
   *
   * Uses path.resolve() + realpathSync (B3/P274) to prevent symlink bypass attacks.
   * Symlinks pointing outside allowed_paths are caught by real-path validation.
   */
  validatePath(filePath: string): void {
    if (filePath.trim().length === 0) {
      throw new Error("Path must not be empty");
    }

    const resolved = path.resolve(filePath);

    // B3 (P274 MiMo-C7): Resolve symlinks before validation.
    // path.resolve() alone does NOT follow symlinks — a symlink pointing outside
    // allowed_paths would bypass the check. realpathSync follows all symlinks.
    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch (_e) {
      // Path does not exist yet (e.g. new file being written).
      // Resolve symlinks on the parent directory instead.
      try {
        const parent    = path.dirname(resolved);
        const realParent = realpathSync(parent);
        realPath = path.join(realParent, path.basename(resolved));
      } catch (_e2) {
        // Broken symlink or entire path chain is invalid — reject
        throw new Error(`Path not accessible (broken symlink or invalid path): ${filePath}`);
      }
    }

    // Ensure trailing separator to prevent prefix confusion
    // e.g. /allowed/dir vs /allowed/dir-other
    const withSep = realPath.endsWith(path.sep) ? realPath : realPath + path.sep;

    // Check blocked_paths first (takes priority) — against the REAL path
    for (const blocked of this.blockedPaths) {
      const blockedWithSep = blocked.endsWith(path.sep) ? blocked : blocked + path.sep;
      if (withSep.startsWith(blockedWithSep) || realPath === blocked) {
        throw new Error(`Path blocked: ${filePath}`);
      }
    }

    // Check allowed_paths — real path must be inside at least one allowed path
    const isAllowed = this.allowedPaths.some((allowed) => {
      const allowedWithSep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
      return withSep.startsWith(allowedWithSep) || realPath === allowed;
    });

    if (!isAllowed) {
      throw new Error(`Path not in allowed paths: ${filePath}`);
    }
  }
}
