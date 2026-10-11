// The background scheduler: a tick every minute, and straight away (after the network is back) when
// the computer wakes up or is unlocked. A long gap between ticks also counts as a wake-up, since
// not every Linux desktop reports resume. The runner decides what's actually due.
import { powerMonitor } from "electron";
import { type Deps, newSched, tick } from "../node/runner.ts";

const EVERY_MS = 60e3;
const WAKE_DELAY_MS = 8e3;   // let Wi-Fi reconnect first

export type Jobs = { syncNow(): Promise<void>; isRunning(): boolean; stop(): void };

/** Cloud mode (P3.5): the script in the student's Google account syncs; this computer only reads it. */
export type CloudJobs = { on(): Promise<boolean>; read(): Promise<unknown>; update(): Promise<void> };
const CLOUD_READ_MS = 5 * 60e3;

export function startJobs(deps: Deps, onRan: () => void, cloud?: CloudJobs): Jobs {
  const sched = newSched();
  let last = Date.now(), wakeTimer: NodeJS.Timeout | null = null, running = 0, lastRead = 0, updated = false;
  const run = async (forceSync = false) => {
    last = Date.now();
    running++;
    try {
      if (cloud && await cloud.on()) {
        if (!updated) { updated = true; await cloud.update().catch((e) => console.error("engine update failed:", e)); }
        if (forceSync || Date.now() - lastRead >= CLOUD_READ_MS) { lastRead = Date.now(); await cloud.read(); }
      } else {
        await tick(deps, sched, { forceSync });
      }
    } catch (e) { console.error("tick failed:", e); } finally { running--; }
    if (process.env.DUELY_DEBUG) console.log("tick done", new Date().toISOString());
    onRan();
  };
  const wake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { wakeTimer = null; void run(); }, WAKE_DELAY_MS);
  };
  const timer = setInterval(() => {
    if (Date.now() - last > 3 * EVERY_MS) wake();                 // slept through several ticks
    else void run();
  }, EVERY_MS);
  powerMonitor.on("resume", wake);
  powerMonitor.on("unlock-screen", wake);
  void run();                                                     // at start: catch up on anything missed
  return {
    syncNow: () => run(true),
    isRunning: () => running > 0,
    stop() {
      clearInterval(timer);
      if (wakeTimer) clearTimeout(wakeTimer);
      powerMonitor.off("resume", wake);
      powerMonitor.off("unlock-screen", wake);
    },
  };
}
