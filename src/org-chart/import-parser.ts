// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-parser — parse CSV, JSON, and XLSX files into RawOrgRow[].
 *
 * P350: Org Chart Import Pipeline
 */

import type { RawOrgRow } from "./import-types.js";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export type FileFormat = "csv" | "json" | "xlsx" | "unknown";

/**
 * Detect the file format from the filename extension or a MIME type hint.
 */
export function detectFormat(filename: string, mimeType?: string): FileFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  if (lower.endsWith(".json"))                             return "json";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv"))   return "csv";

  // Fallback to MIME type
  if (mimeType !== undefined) {
    if (mimeType.includes("spreadsheetml") || mimeType.includes("excel")) return "xlsx";
    if (mimeType.includes("json"))  return "json";
    if (mimeType.includes("csv") || mimeType.includes("text/plain"))      return "csv";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

/**
 * Parse a CSV (or TSV) string into RawOrgRow[].
 *
 * Auto-detects comma vs tab delimiter by sampling the first line.
 * Handles quoted fields (RFC 4180) and ignores empty rows.
 */
export function parseCsv(text: string): RawOrgRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];

  // Detect delimiter: use tab if the first line has more tabs than commas
  const firstLine = lines[0] ?? "";
  const tabCount   = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g)  ?? []).length;
  const delimiter  = tabCount > commaCount ? "\t" : ",";

  const splitRow = (line: string): string[] => {
    const result: string[] = [];
    let field  = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch   = line[i] as string;
      const next = line[i + 1];
      if (inQuote) {
        if (ch === '"' && next === '"') {
          // Escaped quote
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuote = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuote = true;
        } else if (ch === delimiter) {
          result.push(field.trim());
          field = "";
        } else {
          field += ch;
        }
      }
    }
    result.push(field.trim());
    return result;
  };

  const headers = splitRow(firstLine).map((h) => h.replace(/^\uFEFF/, "")); // strip BOM

  const rows: RawOrgRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const cells = splitRow(line);
    const row: RawOrgRow = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (key !== undefined && key !== "") {
        row[key] = cells[j] ?? "";
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into RawOrgRow[].
 *
 * Accepts:
 *  - An array:  [ { "Name": "Alice", ... }, ... ]
 *  - An object with one array property: { "employees": [ ... ] }
 */
export function parseJson(text: string): RawOrgRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_e) {
    throw new Error("Invalid JSON: could not parse file contents");
  }

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeJsonRow);
  }

  // Object wrapper — find first array property
  if (typeof parsed === "object" && parsed !== null) {
    for (const val of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        return val.map(normalizeJsonRow);
      }
    }
  }

  throw new Error("Invalid JSON structure: expected an array or an object containing an array");
}

function normalizeJsonRow(item: unknown): RawOrgRow {
  if (typeof item !== "object" || item === null) {
    return {};
  }
  const row: RawOrgRow = {};
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    row[k] = v === null || v === undefined ? "" : String(v);
  }
  return row;
}

// ---------------------------------------------------------------------------
// XLSX parser (dynamic import — SheetJS optional dep)
// ---------------------------------------------------------------------------

/**
 * Parse an XLSX buffer into RawOrgRow[].
 *
 * Uses SheetJS (`xlsx` package) via dynamic import.
 * If the package is not installed, throws a clear error.
 */
export async function parseXlsx(buffer: Buffer): Promise<RawOrgRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let XLSX: any;
  try {
    const mod = await import("xlsx") as Record<string, unknown>;
    XLSX = mod["default"] ?? mod;
  } catch (_e) {
    throw new Error(
      "XLSX parsing requires the 'xlsx' package (SheetJS). Install it with: npm install xlsx",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const workbook = XLSX.read(buffer, { type: "buffer" }) as {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };

  const sheetName = workbook.SheetNames[0];
  if (sheetName === undefined) return [];
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) return [];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: "" }) as Record<string, unknown>[];
  return jsonRows.map(normalizeJsonRow);
}
