# Developing Duely

Electron + TypeScript. The engine (`src/core`) runs both in the desktop app and, bundled, as the student's Apps
Script (`src/gas`, built by `scripts/build-gas.ts`). The Discord relay is a Cloudflare Worker in `relay/`.

```sh
npm install
npm run dev        # the app with hot reload
npm test           # all tests (node:test, TypeScript through --experimental-strip-types)
npm run typecheck
npm run build      # app + the Apps Script bundle (out/gas)
npm run dist       # installers for this system, in dist/ (nothing is published)
```

Live checks that cost requests, run by hand:
- `node --experimental-strip-types test/eval_models.ts --limit 150 --delay 6000`: the chat's oracle and regression
  cases against a real AI (key file: `--key-file`, default the dev Gemini key).

## Releases
Installers are built by `.github/workflows/release.yml` on Windows, macOS and Linux, unsigned (see the README for
what students click the first time). Updates come from GitHub Releases through `electron-updater`
(`src/main/updates.ts`): Windows and the AppImage install themselves; macOS and the .deb get a download link.

To cut a release:
1. Set `"version"` in `package.json` (a beta is `0.3.0-beta.1`; betas only update to betas and stable releases,
   stable copies only to stable releases).
2. Add the changes to `CHANGELOG.md`.
3. Commit, then tag and push: `git tag v0.3.0-beta.1 && git push origin v0.3.0-beta.1`.
4. The workflow builds everything and creates a **draft** release (a pre-release for `-beta` tags) with the
   installers and the `latest*.yml` update files.
5. Check the draft's files and notes, and that its tag is `v…` (not `untagged-…`; a draft edited through the API can lose it, which once published the beta on a stray tag). Then click **Publish release**. Running copies offer the update within six hours
   (or at once with Settings → About → Check for updates).

"Run workflow" on the Release workflow (once it's on `main`) builds the installers without publishing them; they're
kept as workflow artifacts for a week.
