// Duely's data on disk: one JSON file per key in the app's data folder, the same get/put interface the
// engine used on Cloudflare KV. Writes are atomic (temp file + rename), validated first (it must parse
// back to the same value), and the previous good copy is kept as .bak and used if a file is damaged.
// (Lesson from the personal version: a bad write once replaced live data with error text.)
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/util.ts";

const safeKey = (k: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k) || k.includes("..")) throw new Error(`bad store key: ${k}`);
  return k;
};

export function fileStore(dir: string): Store & { dir: string } {
  mkdirSync(dir, { recursive: true });
  const queue = new Map<string, Promise<void>>();                      // writes to one key happen in order
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  return {
    dir,
    async get<T = any>(key: string): Promise<T | null> {
      const path = join(dir, `${safeKey(key)}.json`);
      for (const p of [path, `${path}.bak`]) {
        if (!existsSync(p)) continue;
        try { return read(p) as T; } catch { /* damaged: try the backup */ }
      }
      return null;
    },
    async put(key: string, value: unknown): Promise<void> {
      const path = join(dir, `${safeKey(key)}.json`);
      if (value === undefined) throw new Error(`refusing to store undefined under ${key}`);
      // values JSON would silently change (NaN/Infinity -> null, functions dropped) are refused
      const text = JSON.stringify(value, (_k, v) => {
        if ((typeof v === "number" && !Number.isFinite(v)) || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
          throw new Error(`refusing to store ${key}: it doesn't survive a JSON round trip`);
        }
        return v;
      });
      if (JSON.stringify(JSON.parse(text)) !== text) throw new Error(`refusing to store ${key}: it doesn't survive a JSON round trip`);
      const prev = queue.get(key) ?? Promise.resolve();
      const next = prev.then(() => {
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, text, { mode: 0o600 });
        if (existsSync(path)) { try { read(path); copyFileSync(path, `${path}.bak`); } catch { /* keep the old .bak */ } }
        renameSync(tmp, path);
      });
      queue.set(key, next.catch(() => {}));
      return next;
    },
  };
}
