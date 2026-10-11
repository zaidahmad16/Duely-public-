import type { Status } from "../../shared/types.ts";

export type Route = "upcoming" | "chat" | "settings";

/** What every screen gets from the app shell. */
export type AppCtx = {
  status: Status | null;
  syncing: boolean;
  /** Sync now; resolves true when it finished without an error. */
  sync(): Promise<boolean>;
  refreshStatus(): Promise<void>;
  go(r: Route): void;
};

export type Screen = {
  el: HTMLElement;
  /** shown (first time or again) */
  mount(): void;
  /** data changed in the background (a sync ran) */
  refresh(): void;
  /** status changed (syncing, last sync) */
  status(): void;
  destroy(): void;
};
