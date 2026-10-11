// Is there a working keyring (Secret Service) on this Linux session? Asked once at start, before
// Electron picks its password store, by calling the service itself (that also starts an activatable
// one, and fails if it can't start). No gdbus: assume there is (Electron's normal behaviour).
import { execFileSync } from "node:child_process";

export function noKeyring(): boolean {
  if (process.platform !== "linux" || process.argv.some((a) => a.startsWith("--password-store"))) return false;
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return true;
  try {
    execFileSync("gdbus", ["call", "--session", "--timeout", "4", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets",
      "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Service", "Collections"],
    { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] });
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
