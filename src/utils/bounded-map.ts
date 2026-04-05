// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * BoundedMap — Map with configurable max size and LRU eviction.
 *
 * Map insertion order acts as the LRU queue:
 *   - get()  refreshes an entry (delete + re-insert → moves to tail)
 *   - set()  evicts the head (oldest access) when at capacity
 *
 * This gives O(1) get, set, and eviction using only native Map operations.
 */

export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new RangeError("BoundedMap maxSize must be >= 1");
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Refresh LRU position: delete + re-insert moves entry to tail
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);  // remove old position before re-inserting at tail
    } else if (this.map.size >= this.maxSize) {
      // At capacity — evict the head (least-recently-used entry)
      const lruKey = this.map.keys().next().value as K | undefined;
      if (lruKey !== undefined) this.map.delete(lruKey);
    }
    this.map.set(key, value);
    return this;
  }

  has(key: K): boolean  { return this.map.has(key); }
  delete(key: K): boolean { return this.map.delete(key); }
  clear(): void          { this.map.clear(); }

  get size(): number { return this.map.size; }

  entries(): IterableIterator<[K, V]> { return this.map.entries(); }
  keys(): IterableIterator<K>         { return this.map.keys(); }
  values(): IterableIterator<V>       { return this.map.values(); }
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.map.entries(); }
}
