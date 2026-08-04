# PR Monitor Distribution

## Build Commands

```bash
npm run desktop:dir
npm run desktop:pack:mac
npm run desktop:pack:win:zip
npm run desktop:pack:win
```

- `desktop:dir` builds an unpacked macOS app for local validation.
- `desktop:pack:mac` builds the unpacked macOS app and then creates a DMG with `hdiutil`. This avoids the local hang observed in electron-builder's DMG stage on this machine.
- `desktop:pack:mac:builder` keeps the native electron-builder DMG path available if a signing/notarization flow needs it later.
- `desktop:pack:win:zip` builds a Windows x64 unpacked app and creates a portable ZIP. This can be built on macOS and used on Windows by extracting the ZIP and running `PR Monitor.exe`.
- `desktop:pack:win` builds a Windows x64 NSIS installer EXE. Run it on Windows or a CI Windows runner for the most reliable installer output.

## Current Local Artifact

The current macOS artifact is:

```text
dist/PR-Monitor-0.1.0-arm64.dmg
```

The current Windows portable artifact, when built, is:

```text
dist/PR-Monitor-0.1.0-win-x64-portable.zip
```

The `dist/win-arm64-unpacked/PR Monitor.exe` file is only an unpacked ARM64 app created during local validation on macOS. It is not the final Windows installer.

## CI Packaging

The workflow below can be triggered manually from GitHub Actions:

```text
.github/workflows/build-desktop.yml
```

It builds:

- macOS DMG on `macos-14`.
- Windows x64 EXE installer on `windows-latest`.

## Bundled Skill

The app bundles `bitbucket-pr-review` from:

```text
app-resources/skills/bitbucket-pr-review
```

Packaged builds copy it into the user's writable app data directory on startup:

```text
<app user data>/skills/bitbucket-pr-review
```

The server reads the runtime skill path from:

```text
BITBUCKET_PR_REVIEW_SKILL_DIR
```

Bitbucket token files are never bundled. They are created at runtime under the copied skill directory:

```text
<app user data>/skills/bitbucket-pr-review/.local/bitbucket-auth.json
```

## User Requirements

End users still need:

- Codex CLI installed and available as `codex`.
- A Bitbucket access token configured during initialization.
- Local repository paths or repo path mappings for PR review.
- Optional shared storage such as MySQL if team-wide data is needed.

## Data Safety

Application data is not bundled in installers. First launch creates a fresh local store unless the user configures another storage backend during initialization.
