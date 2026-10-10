// Headless Duely (no window): run the engine from a terminal. Used for development and tests, and it
// reads the same data folder as the app.
//   node --experimental-strip-types src/cli.ts sync [--feed URL|FILE] [--dir DATA_DIR]
//   node --experimental-strip-types src/cli.ts test-ai
// AI from config.json "ai" {provider, model, baseUrl} + key, or env DUELY_PROVIDER / DUELY_MODEL /
// DUELY_BASE_URL / DUELY_API_KEY (the app keeps the key in the OS keychain instead).
import { existsSync, readFileSync } from "node:fs";
import { makeLLM } from "./llm/adapters.ts";
import { describeCaps, probe } from "./llm/probe.ts";
import type { LLM, Provider } from "./llm/types.ts";
import { DEFAULTS, build, serial } from "./core/sync.ts";
import { fileStore } from "./node/store.ts";
import { dataDir } from "./node/paths.ts";

export { dataDir };

export function llmFrom(cfg: any, env = process.env): LLM | undefined {
  const ai = cfg.ai ?? {};
  const provider = (env.DUELY_PROVIDER ?? ai.provider) as Provider | undefined;
  const model = env.DUELY_MODEL ?? ai.model;
  if (!provider || !model) return undefined;
  return makeLLM({ provider, model, apiKey: env.DUELY_API_KEY ?? ai.apiKey ?? "", baseUrl: env.DUELY_BASE_URL ?? ai.baseUrl });
}

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const cmd = process.argv[2];
  const store = fileStore(arg("dir") ?? dataDir());
  const cfg = { ...DEFAULTS, ...((await store.get<any>("config")) ?? {}) };
  const tz = cfg.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const llm = llmFrom(cfg);
  if (cmd === "test-ai") {
    if (!llm) { console.log("No AI set up: set config.json \"ai\" or DUELY_PROVIDER / DUELY_MODEL / DUELY_API_KEY"); process.exit(1); }
    console.log(llm.label);
    for (const line of describeCaps(await probe(llm))) console.log("  " + line);
    return;
  }
  if (cmd === "sync") {
    const feed = arg("feed") ?? cfg.feed_url;
    if (!feed) { console.log("No Brightspace calendar link: --feed URL (or feed_url in config.json)"); process.exit(1); }
    const text = existsSync(feed) ? readFileSync(feed, "utf8")
      : await (await fetch(feed.replace(/^webcal:\/\//, "https://"), { headers: { "User-Agent": "Duely/1.0" } })).text();
    if (!text.slice(0, 2000).includes("BEGIN:VCALENDAR")) { console.log("That link didn't return a calendar feed."); process.exit(1); }
    const [items, status] = await build({ store, cfg, tz, fetch, llm }, text);
    const kept = items.filter((i) => i.keep !== false);
    await store.put("state", { time: Date.now() / 1000, items: items.map((i) => serial(i, tz)), ai: status, error: "" });
    console.log(`${kept.length} items (${items.length - kept.length} filtered out)${status ? `  ·  ${status}` : ""}`);
    for (const it of kept.slice(0, 40)) console.log(`  ${it.type.padEnd(10)} ${it.course ? it.course + " " : ""}${it.title}`);
    return;
  }
  console.log("usage: cli.ts sync [--feed URL|FILE] [--dir DATA_DIR]  |  cli.ts test-ai");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
