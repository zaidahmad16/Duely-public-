// The Apps Script API calls Duely needs to put its engine in the student's Google account: make the
// project, upload its files, and publish the web app the desktop talks to (P3.5).
// Needs the sign-in scopes SCRIPT_API_SCOPES, and the student's "Google Apps Script API" setting on.

const API = "https://script.googleapis.com/v1";

export const SCRIPT_API_SCOPES = [
  "https://www.googleapis.com/auth/script.projects",     // create and update Duely's script
  "https://www.googleapis.com/auth/script.deployments",  // its web app (the desktop's channel)
];

export const USER_SETTINGS_URL = "https://script.google.com/home/usersettings";

/** The student hasn't turned on "Google Apps Script API" in their Apps Script settings. */
export class ScriptApiOff extends Error {}

export type ScriptFile = { name: string; type: "SERVER_JS" | "JSON"; source: string };

export function scriptApi(token: () => Promise<string>, f: typeof fetch = fetch) {
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const r = await f(`${API}${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* reported below */ }
    if (r.status >= 400) {
      const msg: string = data?.error?.message ?? text.slice(0, 200);
      if (/User has not enabled the Apps Script API/i.test(msg)) {
        throw new ScriptApiOff("Turn on \"Google Apps Script API\" in your Apps Script settings, then try again.");
      }
      throw new Error(`Apps Script ${r.status}: ${msg}`);
    }
    return data;
  }
  return {
    /** Does the student's account allow Duely to manage its script? (A harmless call that needs it.) */
    async apiEnabled(): Promise<boolean> {
      try { await call("GET", "/projects/0000000000000000000000000000000000000000000000000000000000"); return true; } catch (e) {
        if (e instanceof ScriptApiOff) return false;
        return true;                                    // any other answer (e.g. 404) means the API is on
      }
    },
    async create(title: string): Promise<string> { return (await call("POST", "/projects", { title })).scriptId; },
    async upload(scriptId: string, files: ScriptFile[]): Promise<void> { await call("PUT", `/projects/${scriptId}/content`, { files }); },
    async version(scriptId: string, description: string): Promise<number> {
      return (await call("POST", `/projects/${scriptId}/versions`, { description })).versionNumber;
    },
    /** A new web-app deployment; returns its id and URL. */
    async deploy(scriptId: string, versionNumber: number): Promise<{ deploymentId: string; url: string }> {
      const d = await call("POST", `/projects/${scriptId}/deployments`, { versionNumber, manifestFileName: "appsscript", description: "Duely" });
      return { deploymentId: d.deploymentId, url: webAppUrl(d) };
    },
    /** Points the existing deployment at a new version: the web-app URL stays the same. */
    async redeploy(scriptId: string, deploymentId: string, versionNumber: number): Promise<string> {
      const d = await call("PUT", `/projects/${scriptId}/deployments/${deploymentId}`, {
        deploymentConfig: { versionNumber, manifestFileName: "appsscript", description: "Duely" },
      });
      return webAppUrl(d);
    },
  };
}

export type ScriptApi = ReturnType<typeof scriptApi>;

function webAppUrl(d: any): string {
  const url = (d?.entryPoints ?? []).find((e: any) => e.entryPointType === "WEB_APP")?.webApp?.url;
  if (!url) throw new Error("Apps Script didn't return a web app address.");
  return url;
}
