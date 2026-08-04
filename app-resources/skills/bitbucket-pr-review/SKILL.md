---
name: bitbucket-pr-review
description: Review Bitbucket Server or Data Center pull requests, query pull requests awaiting the user's review, fetch the PR diff into a local repo, identify correctness regressions and missing tests, and optionally post precise inline comments through the Bitbucket REST API. Use when Codex is given a Bitbucket PR URL or ID plus repo context and needs to perform code review or publish review findings directly on the PR, or when the user asks how many PRs need their review.
---

# Bitbucket Pr Review

Review the PR against its real target commit, not the current local branch. Post inline comments only for confirmed issues, and keep each comment tied to one concrete finding.

This skill may keep a previously confirmed Bitbucket `accessToken` in a local file under the skill directory so the user does not need to resend it every time. When no confirmed local token is available, ask the user for an `accessToken` before starting the review. Do not assume browser cookies, local credential helpers, or cached auth are acceptable substitutes.

Read [references/bitbucket-api.md](references/bitbucket-api.md) when you need the exact REST endpoints, auth pattern, or comment payload shape.

## Workflow

### Query PRs Awaiting Review

Use this flow when the user asks how many PRs need their review, asks for their pending reviews, or gives a dashboard URL such as `https://bitbucket.example.com/dashboard`.

1. Resolve authentication before querying.

- First check for a local token file at `.local/bitbucket-auth.json` under this skill directory.
- If that file exists, read the stored metadata and explicitly ask the user whether to reuse that token, for example by naming the stored username or display name.
- If the user declines reuse, or if no local token file exists, stop and ask for a fresh `accessToken` before continuing.
- Prefer `Authorization: Bearer <token>` when querying.

2. Query the dashboard PR endpoint.

- Use the dashboard endpoint documented in [references/bitbucket-api.md](references/bitbucket-api.md).
- Query open PRs where the authenticated user is a reviewer and has not approved yet:
  - `state=OPEN`
  - `role=REVIEWER`
  - `participantStatus=UNAPPROVED`
- Use a high enough `limit` for ordinary results, but handle pagination if `isLastPage` is false.
- Treat the returned `size`/`values.length` across all pages as the number of PRs needing review.

3. Report the pending reviews.

- State the count first.
- List each PR with project, repo, PR id, title, author, and the authenticated user's reviewer status when available.
- Do not claim that browser dashboard content was inspected unless you actually used a browser session. Prefer the API result when available.

### Review A Specific PR

1. Resolve the PR and repo context.

- Parse `project`, `repo`, and `pull request id` from the URL if the user gives a full Bitbucket link.
- First check for a local token file at `.local/bitbucket-auth.json` under this skill directory.
- If that file exists, read the stored metadata and explicitly ask the user whether to reuse that token, for example by naming the stored username or display name.
- If the user declines reuse, or if no local token file exists, stop and ask for a fresh `accessToken` before continuing.
- After the user provides a fresh token and it is successfully validated, store it in `.local/bitbucket-auth.json` together with small identity metadata such as `username`, `displayName`, and `updatedAt`.
- Confirm the local repo matches the PR repo before fetching anything.
- Prefer `Authorization: Bearer <token>` when the user provides an API key.
- Expect network calls and `git fetch` into `.git/` to need approval in sandboxed environments.

2. Fetch the exact PR snapshot.

- Query PR metadata first so you have `fromRef.latestCommit` and `toRef.latestCommit`.
- Fetch `refs/pull-requests/<id>/from` into a dedicated remote-tracking ref instead of reviewing the user’s current branch.
- Compare the PR against `toRef.latestCommit`, not a guessed target branch name.
- Use a temporary worktree if the current checkout is dirty or if you need to run tests without mixing user changes into the review.

3. Review with a code-review mindset.

- Prioritize bugs, behavioral regressions, state leakage, missing compatibility handling, and missing tests.
- Classify every confirmed issue with a severity prefix before you comment or report it:
  - `P0`: severe issue, such as a correctness break, data loss risk, security issue, or release-blocking regression.
  - `P1`: substantial risk, such as a likely regression, broken contract, or missing guard in an important flow.
  - `P2`: smaller but still real risk, such as a narrower regression or contract mismatch worth fixing.
- Read surrounding code on both sides of the diff when the change touches legacy bridge layers or compatibility shims.
- Treat comments that say “reuse old flow”, “legacy”, `TemplateHelper`, transport adapters, config sync code, or preview bridge code as high-risk areas.
- For frontend PRs that modify config logic, especially special-case rewrites before requests or centralized config mutation/normalization steps, explicitly trace the config flow end to end: where the config originates, every mutation point, any request-time rewrite, any persistence or sync path, and where it is read back.
- For those frontend config changes, enumerate the user operations or lifecycle scenarios that can affect the config, such as create, edit, switch widget/type, reopen, undo/redo, preview, save, publish, refresh, reload from server, and compatibility fallback.
- Distinguish confirmed issues from open questions. Post inline comments only for confirmed issues.
- Do not force a fixed number of comments. Disclose every confirmed `P1` and above issue you find. If there are no confirmed `P1+` issues, disclose confirmed `P2` issues instead.

4. Validate before commenting when feasible.

- Run targeted tests for touched areas if the environment supports them.
- If tests cannot run because the environment is missing local assets or dependencies, say so explicitly in the final review summary.
- Do not block on full test execution if a static review already reveals a concrete bug.

5. Post inline comments carefully.

- Anchor every comment to the exact PR file and target-side line from the fetched PR snapshot, not from the mutable local branch.
- Use the inline comment method documented in [references/bitbucket-api.md](references/bitbucket-api.md). Do not improvise another posting path when the documented method is available.
- Prefer one issue per inline comment.
- Prefix every inline comment title/body with its severity marker, for example `[P0]`, `[P1]`, or `[P2]`.
- Write Bitbucket inline comments in Chinese by default, while keeping code identifiers, API names, file paths, and severity markers unchanged.
- Keep the comment factual: state the bug, explain why the current code still fails, and suggest the missing condition or lifecycle reset when obvious.
- Avoid speculative or style-only comments unless the user explicitly asked for broader feedback.
- Post all confirmed issues that meet the disclosure threshold from step 3; do not stop after the first one.

6. Report back to the user.

- List the findings first, ordered by severity (`P0` before `P1` before `P2`), then any testing gaps.
- For frontend PRs with config-mutation changes, add a separate “config flow and impacted scenarios” summary for the user even when you have not confirmed a bug yet. This summary should describe the config path and the operation scenarios that may exercise it, so the user can judge whether the design itself is risky.
- If you posted comments, include the file/line or comment IDs so the user can locate them quickly.
- Mention any commands that required approval or any API quirks you had to work around.

## Review Checklist

- Verify the PR diff against `toRef.latestCommit`.
- Verify that local unrelated changes are not part of the review surface.
- Verify high-risk state flows: widget switch, cache invalidation, async preview refresh, fallback branches, and config synchronization.
- For frontend config changes, verify the full config lifecycle: source input, in-memory mutations, pre-request transformation, server round-trip, reload/export/import/backfill, and cross-scene reuse.
- For frontend config changes, verify which operations can hit each mutation point and call those scenarios out explicitly to the user even if they are not yet confirmed bugs.
- Verify added compatibility code is actually reachable.
- Verify tests cover the new behavior, not just the happy path.
- Verify inline comment line numbers against `git show upstream/pr/<id>:<path> | nl -ba`.
- Verify that every confirmed `P1+` issue has been disclosed, or if there are none, that confirmed `P2` issues have been disclosed instead.

## Common Traps

- Do not diff against the local checked-out target branch if the PR API already tells you the exact target commit.
- Do not assume the PR branch is already present locally.
- Do not post review comments against files from the user’s branch when the PR branch content differs.
- Do not assume you can list all comments without a `path` filter; Bitbucket comment APIs may require file scoping for retrieval.
- Do not start the review without either getting user confirmation to reuse the stored token or collecting a fresh `accessToken`.
- Do not forget the severity prefix in inline comments or the final findings list.
- Do not artificially cap the number of review comments; disclose all confirmed findings that meet the severity threshold.
- Do not claim testing happened if the test environment failed before execution.

## Resource Usage

- Read [references/bitbucket-api.md](references/bitbucket-api.md) before issuing review-comment API calls or when you need the exact fetch/comment commands.
