// Secrets (the AI key, the Google client and sign-in, later Slack tokens): encrypted with the OS
// keychain through Electron's safeStorage, stored as base64 in secrets.json. Never plain JSON.
// The cipher is passed in so this works (and is tested) without Electron.
import type { Store } from "../core/util.ts";

export type Cipher = {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
  /** saved without real encryption (Linux without a keyring); `reseal` upgrades these once a keyring works */
  weak?(data: Buffer): boolean;
};

export type SecretName = "llm_key" | "google_client" | "google_refresh" | "discord_link" | "cloud_link";

export type Secrets = {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  has(name: SecretName): Promise<boolean>;
  /** Encrypts again every value saved while the computer had no keyring; returns how many. */
  reseal(): Promise<number>;
};

export function secretStore(store: Store, cipher: Cipher): Secrets {
  const load = async () => (await store.get<Record<string, string>>("secrets")) ?? {};
  return {
    async get(name) {
      const v = (await load())[name];
      if (!v) return null;
      if (!cipher.available()) throw new Error("This computer's keychain isn't available, so Duely can't read its saved keys.");
      try { return cipher.decrypt(Buffer.from(v, "base64")); } catch {
        throw new Error("Duely couldn't unlock a saved key (the keychain changed?). Enter it again in Settings.");
      }
    },
    async set(name, value) {
      if (!cipher.available()) throw new Error("This computer's keychain isn't available, so Duely can't save keys safely.");
      const enc = cipher.encrypt(value).toString("base64");
      if (cipher.decrypt(Buffer.from(enc, "base64")) !== value) throw new Error("Saving the key failed a check; nothing was saved.");
      await store.put("secrets", { ...(await load()), [name]: enc });
    },
    async delete(name) {
      const all = await load();
      if (!(name in all)) return;
      delete all[name];
      await store.put("secrets", all);
    },
    async has(name) { return !!(await load())[name]; },
    async reseal() {
      if (!cipher.weak) return 0;
      const all = await load();
      // look first: asking the keyring when there's nothing to redo could show an unlock prompt at every start
      if (!Object.values(all).some((v) => cipher.weak!(Buffer.from(v, "base64"))) || !cipher.available()) return 0;
      const out = { ...all };
      let n = 0;
      for (const [name, v] of Object.entries(all)) {
        const data = Buffer.from(v, "base64");
        if (!cipher.weak(data)) continue;
        let text: string;
        try { text = cipher.decrypt(data); } catch { continue; }                 // unreadable: left for the student to re-enter
        const enc = cipher.encrypt(text);
        if (cipher.weak(enc) || cipher.decrypt(enc) !== text) return 0;          // still no real encryption: change nothing
        out[name] = enc.toString("base64");
        n++;
      }
      if (n) await store.put("secrets", out);
      return n;
    },
  };
}
