// Secrets (the AI key, the Google client and sign-in, later Slack tokens): encrypted with the OS
// keychain through Electron's safeStorage, stored as base64 in secrets.json. Never plain JSON.
// The cipher is passed in so this works (and is tested) without Electron.
import type { Store } from "../core/util.ts";

export type Cipher = {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
};

export type SecretName = "llm_key" | "google_client" | "google_refresh" | "discord_link";

export type Secrets = {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  has(name: SecretName): Promise<boolean>;
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
  };
}
