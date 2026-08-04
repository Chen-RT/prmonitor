# Security

## Sensitive Data

Do not commit:

- Bitbucket access tokens.
- `.local/bitbucket-auth.json`.
- Runtime `data/` stores.
- SQLite, MySQL dumps, logs, screenshots, or generated review output.
- Packaged installers or unpacked app directories.

## Reporting Issues

If you find a token leak or another security issue, rotate the affected credential first, then open a private security report in the repository.

## Runtime Auth

The app expects users to configure Bitbucket tokens from the initialization wizard or personal settings page. Packaged builds copy the bundled review skill to a writable app data directory and store runtime auth there, outside the application bundle.
