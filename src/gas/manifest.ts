// Duely's Apps Script manifest (appsscript.json). Built at install time: it carries the student's
// time zone. Used by the desktop app's installer and by scripts/build-gas.ts.

/** Permissions the script itself asks for (shown on Google's approval screen). */
export const SCRIPT_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",   // only the calendar Duely makes
  "https://www.googleapis.com/auth/script.external_request", // Brightspace, the AI provider
  "https://www.googleapis.com/auth/script.scriptapp",       // its own 10-minute timer
  "https://www.googleapis.com/auth/script.send_mail",       // alerts by email, only if turned on
  "https://www.googleapis.com/auth/userinfo.email",         // whose inbox those emails go to
];

export function manifest(timeZone: string): string {
  return JSON.stringify({
    timeZone, runtimeVersion: "V8", exceptionLogging: "STACKDRIVER", oauthScopes: SCRIPT_SCOPES,
    // reached by link + the channel key (src/gas/main.ts keyOk)
    webapp: { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" },
    // the Calendar advanced service: switched on for the script by this line alone
    dependencies: { enabledAdvancedServices: [{ userSymbol: "Calendar", serviceId: "calendar", version: "v3" }] },
  }, null, 2);
}

/** The first file in the project: only the one function the student runs, so the editor opens on it
 *  and "Run" is one click. */
export const START_FILE = `// Duely: click Run (above) once to approve Duely in your Google account.
function duelySetup() { return Duely.duelySetup(); }
`;

/** The installer's settings file: the first settings and the channel key (read once by duelySetup). */
export const configFile = (config: object, channelKey: string) =>
  `// Written by the Duely app. Your settings live in Duely; this file is only read once, at setup.\nvar DUELY_CONFIG = ${JSON.stringify(config)};\nvar DUELY_CHANNEL_KEY = ${JSON.stringify(channelKey)};\n`;
