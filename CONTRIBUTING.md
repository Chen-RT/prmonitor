# Contributing

## Development Checks

Before opening a pull request, run:

```bash
node --check server.mjs
node --check electron/main.mjs
node --check scripts/create-dmg.mjs
node --check scripts/create-win-zip.mjs
```

When changing packaging, also run the relevant build command:

```bash
npm run desktop:pack:mac
npm run desktop:pack:win:zip
```

## Data Hygiene

Keep runtime data out of commits. The project `.gitignore` excludes data stores, credentials, logs, and build artifacts. If you add a new runtime output path, add it to `.gitignore` in the same change.
