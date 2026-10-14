import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResolvedStream } from './types.js';

interface CachedStreamEntry {
  stream: ResolvedStream;
  expiresAt: number; // Unix timestamp in seconds
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', '.idlix_cache.json');

export class StreamCache {
  private cache: Map<string, CachedStreamEntry> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        const now = Math.floor(Date.now() / 1000);
        for (const [key, entry] of Object.entries(data)) {
          const item = entry as CachedStreamEntry;
          if (item.expiresAt > now) {
            this.cache.set(key, item);
          }
        }
      }
    } catch {
      // Ignore disk load errors
    }
  }

  private saveToDisk() {
    try {
      const obj: Record<string, CachedStreamEntry> = {};
      const now = Math.floor(Date.now() / 1000);
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt > now) {
          obj[key] = entry;
        }
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      // Ignore disk write errors
    }
  }

  get(key: string): ResolvedStream | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (now >= entry.expiresAt) {
      this.cache.delete(key);
      this.saveToDisk();
      return null;
    }

    return entry.stream;
  }

  set(key: string, stream: ResolvedStream) {
    const expiresAt = stream.expiresAt || Math.floor(Date.now() / 1000) + (stream.ttlSeconds || 3600);
    this.cache.set(key, { stream, expiresAt });
    this.saveToDisk();
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }
}

export const globalCache = new StreamCache();
