// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Minimal PNG generation using Node.js built-in zlib.
 * Produces valid RGB PNG files without external dependencies.
 */

import { deflateSync } from "node:zlib";


// CRC-32 lookup table — computed once at module load (polynomial 0xEDB88320).
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
})();

/** Compute CRC-32 of a Buffer using the standard polynomial 0xEDB88320. */
function crc32(data: Buffer): number {
  const table = CRC32_TABLE;
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc = (table[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Wrap data into a PNG chunk with length, 4-byte type, data, and CRC. */
function makeChunk(type: string, data: Buffer): Buffer {
  const len        = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput   = Buffer.concat([typeBuffer, data]);
  const crcValue   = Buffer.allocUnsafe(4);
  crcValue.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuffer, data, crcValue]);
}


/**
 * Generate a minimal solid-colour PNG using deflate compression.
 *
 * @param width   Image width in pixels
 * @param height  Image height in pixels
 * @param r       Red channel (0–255)
 * @param g       Green channel (0–255)
 * @param b       Blue channel (0–255)
 */
export function createSolidColorPNG(
  width:  number,
  height: number,
  r:      number,
  g:      number,
  b:      number,
): Buffer {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit-depth=8, color-type=2 (RGB), rest zeros
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // RGB color type
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // Build raw image data: one filter byte (0=None) + RGB pixels per row
  const scanlineLen = 1 + width * 3;
  const imageData   = Buffer.allocUnsafe(height * scanlineLen);
  for (let y = 0; y < height; y++) {
    const base = y * scanlineLen;
    imageData[base] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      imageData[base + 1 + x * 3]     = r;
      imageData[base + 2 + x * 3]     = g;
      imageData[base + 3 + x * 3]     = b;
    }
  }

  const compressed = deflateSync(imageData);

  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** SIDJUA brand blue: #2563eb → RGB(37, 99, 235) */
export const BRAND_COLOR = { r: 37, g: 99, b: 235 } as const;

/**
 * Generate a minimal ICO file containing a 32×32 PNG image.
 *
 * The ICO format supports embedded PNG data directly (PNG-in-ICO), which is
 * accepted by all modern browsers and Windows.  No external dependencies.
 *
 * @param r  Red channel (0–255)
 * @param g  Green channel (0–255)
 * @param b  Blue channel (0–255)
 */
export function createFaviconIco(r: number, g: number, b: number): Buffer {
  const png = createSolidColorPNG(32, 32, r, g, b);

  // ICONDIR header (6 bytes)
  const header = Buffer.allocUnsafe(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type: 1 = icon
  header.writeUInt16LE(1, 4);  // count: 1 image

  // ICONDIRENTRY (16 bytes)
  const entry = Buffer.allocUnsafe(16);
  entry[0] = 32;                         // width: 32px
  entry[1] = 32;                         // height: 32px
  entry[2] = 0;                          // color count: 0 (true color)
  entry[3] = 0;                          // reserved
  entry.writeUInt16LE(1, 4);             // planes: 1
  entry.writeUInt16LE(32, 6);            // bit count: 32 (RGBA)
  entry.writeUInt32LE(png.length, 8);    // size of PNG data
  entry.writeUInt32LE(6 + 16, 12);       // offset: immediately after header + entry

  return Buffer.concat([header, entry, png]);
}
