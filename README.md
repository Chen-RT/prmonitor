# PR Monitor

PR Monitor is a desktop and local web app for tracking Bitbucket pull requests that need review. It can synchronize PR status, manage review jobs, run scheduled checks, and invoke a bundled `bitbucket-pr-review` Codex skill to review PRs and post inline comments.

## Features

- First-run initialization wizard for super admin, Bitbucket, storage, local environment, and review policy.
- User roles: super admin, admin, and regular user.
- User-scoped PRs, review jobs, Bitbucket identity aliases, repository path mappings, and access tokens.
- Admin-managed platform settings, storage settings, user management, and event logs.
- PR buckets for awaiting review, reviewed but not approved, approved, and imported PRs.
- Review job execution with streamed AI output shown on the job card.
- Manual PR import, manual approve, and scheduled auto-review for new pending PRs.
- HMAC-verified Bitbucket webhooks for PR creation and source-branch updates.
- Repository-specific review standards with versioned task snapshots and path rules.
- Storage backends: local JSON, gzip-compressed local JSON, SQLite, and MySQL/MariaDB.
- Storage migration with connection testing, automatic table creation, and data synchronization.
- Electron desktop packaging for macOS and Windows.

## Requirements

- Node.js 22 or newer.
- Codex CLI available as `codex` when using automatic review jobs.
- A Bitbucket Server/Data Center access token.
- Local repository paths for PRs that should be reviewed by Codex.
- Optional MySQL/MariaDB server for shared or long-running storage.

## Local Development

```bash
npm install
npm start
```

The local server defaults to:

```text
http://localhost:4177
```

For the Electron app:

```bash
npm run desktop
```

## Configuration

The app is configured from the initialization wizard on first launch. Runtime configuration and tokens are intentionally not committed.

Useful environment variables:

```bash
PORT=4177
PR_MONITOR_DEFAULT_BITBUCKET_URL=https://bitbucket.example.com
PR_MONITOR_DATA_DIR=/absolute/path/to/pr-monitor-data
BITBUCKET_PR_REVIEW_SKILL_DIR=/absolute/path/to/bitbucket-pr-review
PR_MONITOR_CODEX_PATH=/absolute/path/to/codex
PR_MONITOR_WEBHOOK_SECRET=replace-with-a-random-secret
```

`PR_MONITOR_CODEX_PATH` may point to either the `codex` executable or the directory that contains it. On Windows, the npm global bin directory is commonly similar to:

```text
C:\Users\<name>\AppData\Roaming\npm
```

Storage options:

- Local JSON: `data/store.json`
- Compressed local JSON: `data/store.json.gz`
- SQLite: `sqlite:///absolute/path/pr-monitor.sqlite`
- MySQL: `mysql://user:password@host:3306/prmonitor`
- MariaDB: `mariadb://user:password@host:3306/prmonitor`

The database must exist before connecting. The app creates and migrates its own business tables.

## Bitbucket Webhook

Platform administrators can configure the webhook entry at:

```text
http://localhost:4177/webhooks.html
```

The public endpoint is:

```text
POST /api/webhooks/bitbucket
```

Configure Bitbucket to send `pr:opened` and `pr:from_ref_updated` events. The handler verifies the raw request body with HMAC-SHA256 and accepts `X-Hub-Signature`, `X-Hub-Signature-256`, or `X-Bitbucket-Signature` in `sha256=<hex>` format. Confirm the actual header emitted by your Bitbucket Server/Data Center version during rollout.

Before enabling it:

- Set `PR_MONITOR_WEBHOOK_SECRET` in the service process environment and restart the service.
- Map each `PROJECT/repository` to an execution user on the Webhook page.
- Ensure that user has a Bitbucket Token and a readable local Git repository mapping.
- Run PR Monitor on a stable port behind HTTPS and a trusted reverse proxy. `localhost` is not remotely reachable.

An Nginx location example is available at `docs/nginx-webhook.conf.example`. The reverse proxy must preserve the request body and signature header unchanged.

## Repository Review Standards

Platform administrators can manage review standards at:

```text
http://localhost:4177/review-standards.html
```

Each standard can define its minimum published severity, general review requirements, and additional requirements for matching file paths. Bind a standard to an exact `PROJECT/repository` key; repositories without an explicit binding use the configured default standard.

Every review job stores an immutable snapshot containing the standard name, version, rules, and SHA-256 hash. Editing a standard does not change queued or historical jobs. To review the same commit with an updated standard, open the task list and choose **按最新标准重评**; this creates a separate queued task and preserves the previous result.

The platform continues to use the single bundled `bitbucket-pr-review` skill for authentication, diff inspection, inline comments, and result handling. Repository standards are injected as task-specific prompt constraints rather than copied into separate skills. Tokens and webhook secrets are not stored in review standards.

## Bundled Skill

The distributable app includes:

```text
app-resources/skills/bitbucket-pr-review
```

Packaged desktop builds copy the skill to the user's app data directory on startup, then use that writable copy for runtime token files. Sensitive files such as `.local/bitbucket-auth.json` are excluded from the repository and installers.

## Build

macOS Apple Silicon DMG:

```bash
npm run desktop:pack:mac
```

Windows x64 portable ZIP:

```bash
npm run desktop:pack:win:zip
```

Windows x64 NSIS installer:

```bash
npm run desktop:pack:win
```

The Windows installer is most reliable when built on Windows or a Windows CI runner. See [DISTRIBUTION.md](DISTRIBUTION.md) for details.

## Security Notes

- Do not commit `data/`, `.env`, `.local/`, database files, logs, or build artifacts.
- Bitbucket access tokens are stored only in runtime user data or the copied skill directory.
- The webhook Secret is read only from the configured environment variable; it is not saved in platform storage or returned by APIs.
- The repository contains example Bitbucket URLs only. Configure the real Bitbucket base URL during initialization.
