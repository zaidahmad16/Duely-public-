// Where Duely keeps its data (the same folder Electron's userData uses for "Duely"). DUELY_HOME
// overrides it, for tests and for running a second copy.
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.DUELY_HOME) return process.env.DUELY_HOME;
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Duely");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Duely");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Duely");
}
