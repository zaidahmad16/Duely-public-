// Small shared helpers: Python-identical JSON + SHA-1 (so hashes match the desktop app),
// HTML entity decoding, and the key/value store interface (KV in production, Map in tests).

/** Byte-for-byte Python json.dumps(obj, sort_keys=True) with default separators and ensure_ascii. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => pyStr(k) + ": " + pyDumps(o[k])).join(", ") + "}";
}

function pyStr(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) =>
    c === "\u007f" ? c : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** SHA-1 of the UTF-8 text, as hex. Web Crypto by default; a host without it (Apps Script) supplies
 *  its own (src/gas), which must give the same bytes: event hashes are compared across hosts. */
let sha1Source: ((s: string) => string) | null = null;
export function setSha1Source(f: ((s: string) => string) | null): void { sha1Source = f; }

export async function sha1hex(s: string): Promise<string> {
  if (sha1Source) return sha1Source(s);
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A query string (URLSearchParams isn't in every host). */
export function qs(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•", middot: "·",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", copy: "©", reg: "®", deg: "°",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", rarr: "→", larr: "←", trade: "™",
};

/** html.unescape for the entities Brightspace actually emits (named subset + numeric). */
function htmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

/** Brightspace descriptions are often HTML; the AI only needs the words (Python aifilter.plain). */
export function plain(text: string): string {
  return htmlUnescape(text.replace(/<[^>]+>/g, " ")).split(/[\s\u0085\u001c-\u001f]+/).filter(Boolean).join(" ");
}

export interface Store {
  get<T = any>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
}

export function kvStore(kv: KVNamespace): Store {
  return {
    get: (k) => kv.get(k, "json"),
    put: (k, v) => kv.put(k, JSON.stringify(v)),
  };
}

export function memStore(init: Record<string, unknown> = {}): Store & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
    put: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); },
  };
}

/** Waiting. Timers by default; Apps Script has none (src/gas supplies Utilities.sleep). */
let sleepSource: ((ms: number) => Promise<void>) | null = null;
export function setSleepSource(f: ((ms: number) => Promise<void>) | null): void { sleepSource = f; }
export const sleep = (ms: number): Promise<void> => (sleepSource ? sleepSource(ms) : new Promise((r) => setTimeout(r, ms)));

export interface KVNamespace {
  get(key: string, type: "json"): Promise<any>;
  put(key: string, value: string): Promise<void>;
}
