# Bitbucket API Notes

## Dashboard PRs Awaiting Review

Use the dashboard pull requests endpoint to count PRs that need the authenticated user's review:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  "https://bitbucket.example.com/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=REVIEWER&participantStatus=UNAPPROVED&limit=1000"
```

Fields that matter most:

- `size`: number of results in the current page
- `values`: PRs in the current page
- `isLastPage`: whether pagination is complete
- `nextPageStart`: pass as `start=<nextPageStart>` when `isLastPage` is false
- `values[].id`: pull request id
- `values[].title`: pull request title
- `values[].author.user.displayName`: author display name
- `values[].toRef.repository.project.key`: project key
- `values[].toRef.repository.slug`: repository slug
- `values[].reviewers[]`: reviewer entries; match the authenticated user's reviewer status when reporting details

Useful filters:

- `state=OPEN`: only open PRs
- `role=REVIEWER`: PRs where the authenticated user is a reviewer
- `participantStatus=UNAPPROVED`: PRs the authenticated user still has not approved

## PR Metadata

Use the PR metadata endpoint first to resolve the real source and target commits:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  "https://bitbucket.example.com/rest/api/1.0/projects/<PROJECT>/repos/<REPO>/pull-requests/<PR_ID>"
```

Fields that matter most:

- `fromRef.latestCommit`: current PR head
- `toRef.latestCommit`: exact target commit to diff against
- `fromRef.displayId` / `toRef.displayId`: human-readable branch names

## Fetch the PR Branch Locally

Fetch the PR source ref into a dedicated local tracking ref:

```bash
git fetch upstream refs/pull-requests/<PR_ID>/from:refs/remotes/upstream/pr/<PR_ID>
```

Then diff against the exact target commit from the metadata response:

```bash
git diff <TO_REF_LATEST_COMMIT>..upstream/pr/<PR_ID>
git log --reverse --oneline <TO_REF_LATEST_COMMIT>..upstream/pr/<PR_ID>
```

Use a temporary worktree when the main checkout is dirty or when you need isolated test execution.

## Inline Comment Endpoint

Post inline review comments with the comments endpoint:

```bash
curl -sS \
  "https://bitbucket.example.com/rest/api/latest/projects/<PROJECT>/repos/<REPO>/pull-requests/<PR_ID>/comments?diffType=EFFECTIVE&markup=true&avatarSize=48" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'EOF'
{
    "text": "[P1] 这里用中文描述一个确认的评审问题。",
    "severity": "NORMAL",
    "anchor": {
      "diffType": "EFFECTIVE",
      "path": "packages/example/file.ts",
      "lineType": "ADDED",
      "line": 29,
      "fileType": "TO"
    }
}
EOF
```

Use:

- `path`: repo-relative file path from the PR
- `line`: target-side line number from the PR snapshot
- `lineType: "ADDED"` and `fileType: "TO"` for destination-side added or changed lines
- Prefix the comment text with the review severity marker, such as `[P0]`, `[P1]`, or `[P2]`
- Write inline comment text in Chinese by default, while keeping code identifiers, API names, file paths, and severity markers unchanged.

Important payload pitfall:

- When sending JSON from stdin or a file, use `--data-binary @-` (or another curl form that really reads stdin).
- Do not use `--data-raw @-` here. Bitbucket will receive the literal string `@-` and return a JSON parse error instead of creating the comment.

## Getting Stable Line Numbers

Do not anchor against the mutable local branch checkout. Read the PR file content directly:

```bash
git show upstream/pr/<PR_ID>:<PATH> | nl -ba | sed -n 'START,ENDp'
```

Use those line numbers for the comment payload.

## Auth Notes

- Token reuse flow:
  - Store the confirmed token in `.local/bitbucket-auth.json` under the skill directory, not in `SKILL.md`, scripts, or committed reference files.
  - Store small metadata next to it, such as `username`, `displayName`, and `updatedAt`, so future reviews can ask the user whether to reuse that identity.
  - On later runs, if the file exists, ask the user to confirm reuse of that stored token before reviewing.
  - If the user declines, or if the stored token no longer works, ask for a fresh token and overwrite the local file after validation.
- Before reviewing a PR, ask the user for an access token if no confirmed stored token is available.
- Prefer `Authorization: Bearer <token>` when the user gives an API key.
- Browser cookie auth can work, but bearer tokens are easier to automate and redact.
- Do not write tokens into `SKILL.md`, scripts, or committed repo files.

Suggested local file shape:

```json
{
  "token": "<access-token>",
  "username": "oliver.chen",
  "displayName": "Oliver.Chen-陈润桐",
  "updatedAt": "2026-07-30T10:13:04+08:00"
}
```

Operational note:

- The file is local state for this skill and should be treated as sensitive. Prefer creating `.local/` if missing and restricting the auth file to user-only permissions where the environment allows it.

## Known Quirks

- Listing comments may require a `path` query parameter on some endpoints. Do not assume a PR-wide comments listing works without file scoping.
- `git fetch` may require escalated permissions in sandboxed environments because it writes to `.git/FETCH_HEAD`.
- Test environments may fail before running if local UI assets are missing; report that as a testing gap rather than fabricating coverage.
