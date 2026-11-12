# Commit status, inline comments, notifications, and a pre-push hook

Status: implemented. Ships as one PR, `feat/status-inline-notify-hook`.

## Why

A review ends in one PR comment today. Nothing can gate a merge on the score, a finding is a link away from the line it names, nobody hears about a review unless they watch the TUI, and scoring a branch before pushing needs a hand-written hook. All four build on data review-relay already has: the combined score, each finding's file, line, and status, and the job's outcome.

## Goals

- A commit status a branch protection rule can require.
- Findings on the lines they name, as one PR review, with GitHub suggestion blocks a reader can apply.
- A ping when a background review finishes badly, or at all.
- `review-relay hook install` wires `review --min-score` into `git push`.

## Non-goals

- Check runs. Creating one needs a GitHub App token; `gh` signs in as a user, which can only set commit statuses.
- Resolving inline threads when a finding is fixed, replying to them, or reading reactions.
- Requesting changes or approving. The inline review is always a `COMMENT` review.
- Statuses or inline comments for local reviews: their commit may not be on GitHub.
- Notifications from a foreground `review`, whose output is already in front of the user.
- Updating PRODUCT.md and the site's landing copy beyond the reference tables the docs test checks.

## Opt-in guarantee

Every feature is off until configured. A config without `status`, `inlineComments`, or `notify` posts the same comment, sets no status, posts no review, and sends nothing. The verdict schema gains two finding fields (below), so reviewer output and `findings.json` grow; nothing reads them unless `inlineComments` is on.

## 1. Commit status

### Config

```json
"repos": [{ "fullName": "acme/widget", "localPath": "~/code/widget", "status": { "minScore": 4 } }]
```

| Field | Default | Meaning |
| - | - | - |
| `repos[].status` | `false` | `true`, or `{ "minScore": N }`, sets a `review-relay` commit status on each reviewed commit. `true` means `minScore` 4. |
| `repos[].status.minScore` | `4` | 1 to 5. The status is `success` when the combined confidence is at least this. |

4 is "minor issues only" in the rubric, so the default passes a PR a reviewer would merge.

### Behavior

The status context is `review-relay`. It is set on the reviewed commit by the process that runs the review (the daemon or `run`), independent of `postToPr`.

| Job outcome | State | Description |
| - | - | - |
| Review starts (after the head check) | `pending` | `Reviewing` (the route, and so the reviewers, is picked inside the run) |
| Done, confidence ≥ `minScore` | `success` | `Confidence 4/5 (needs 4) · Claude 4, Codex 5` |
| Done, confidence < `minScore` | `failure` | `Confidence 2/5 (needs 4) · Claude 2, Codex 4` |
| Skip route | `success` | `Skipped by route docs` |
| Every reviewer failed, or the job failed | `error` | `Review failed: <first 100 characters>` |
| Cancelled after it started | `error` | `Review cancelled` |
| Superseded | not touched | The PR's head has its own status. |

- Descriptions are cut to GitHub's 140 characters.
- `target_url` is the PR comment when one was posted, else the PR.
- A status that fails to post is logged and never fails the review.
- Drafts, excluded authors, and PRs no trigger fires on get no status, so a required `review-relay` check blocks them. The README says to require it only where every PR gets reviewed, or to comment `@review-relay` to unblock one.

## 2. Inline review comments

### Config

| Field | Default | Meaning |
| - | - | - |
| `repos[].inlineComments` | `false` | Also post each new finding as a comment on its line, in one PR review. Needs `postToPr`. |

`inlineComments` with `postToPr: false` is a load warning and posts nothing.

### Schema

Two finding fields, both required by the strict schema and nullable:

- `endLine`: the last line the finding covers, or null for `line` alone.
- `replacement`: the exact new text for lines `line` through `endLine` (or `line` alone), keeping indentation, or null when the fix is not a small edit to those lines.

`parseVerdict` keeps them only when valid: `endLine` an integer past `line`, `replacement` a string (empty deletes the lines) on a finding with a `line`. Reports from before have neither.

When findings merge, the first reviewer's `replacement` and `endLine` stay. A finding without one takes the next reviewer's only when both name the same `line`, since a replacement belongs to its range.

### Behavior

After the summary comment is posted (in the same per-PR turn, so it is skipped when the PR moved on), review-relay posts one `COMMENT` review on the reviewed commit:

- Only findings that are new: status `new`, or no status on a PR's first review. An `open` finding was already commented on.
- Only findings whose `line` is an added or changed line of `git diff -U0 base...head` in the clone, on the new side. GitHub rejects a whole review when one comment names a line outside the diff, so findings on context or untouched lines stay in the summary comment only.
- A finding whose range `line`..`endLine` is all added lines, contiguous, gets a multi-line comment and, with a `replacement`, a ```` ```suggestion ```` block. Otherwise it comments on `line` alone and drops the suggestion, since a suggestion replaces exactly the commented lines.
- Each comment: the severity badge and title, the reviewers and dimension, the detail, then the suggestion block or the written suggested fix, then a hidden `<!-- review-relay:finding -->` marker.
- Before posting, the signed-in user's earlier marked review comments on the PR are read. A finding is dropped when one of them is on the same commit, the same path, and a line within 3: that covers a mention or `run` re-reviewing the same commit.
- The review body is one line linking the summary comment. No review is posted when no finding qualifies.
- A failed review post is logged as a warning on the job; the summary comment stands.

## 3. Notifications

### Config

```json
"notify": {
  "on": ["low", "failed"],
  "minScore": 4,
  "desktop": true,
  "ntfy": "https://ntfy.sh/my-reviews",
  "slack": "https://hooks.slack.com/services/...",
  "webhook": "https://example.com/review-relay"
}
```

| Field | Default | Meaning |
| - | - | - |
| `notify` | unset | Off when unset. At least one channel is required. |
| `notify.on` | `["low", "failed"]` | `done`: every finished review. `low`: confidence under `minScore`. `failed`: every reviewer failed, or the job failed. |
| `notify.minScore` | `4` | 1 to 5, for `low`. |
| `notify.desktop` | `false` | macOS `osascript`, Linux `notify-send`, Windows a PowerShell toast. On Linux without `notify-send` but with `powershell.exe` (WSL), the Windows toast. |
| `notify.ntfy` | unset | An ntfy topic URL. The message is the body, with `Title`, `Tags`, and `Click` headers. |
| `notify.slack` | unset | A Slack incoming webhook URL. Gets `{ "text": ... }`. |
| `notify.webhook` | unset | Any URL. Gets the event as JSON (below), plus `text`. |

### Behavior

- Sent by whatever process records the job's end: the daemon, `run` (and the MCP server's `review_pr`), and background local reviews (`review -d`, the TUI's `r`, `review_branch`). A foreground `review` sends nothing.
- Skipped, superseded, and cancelled jobs send nothing.
- Title: `review-relay: acme/widget #42` (local: `review-relay: acme/widget feat/x`). Text: `Confidence 2/5 · 1 critical, 2 major · Claude 2, Codex 4`, or `Review failed: ...`. The link is the PR comment, else the PR; none for local reviews.
- Webhook JSON: `{ event: "done" | "failed", repo, pr, branch, local, headSha, score, findings: { critical, major, minor }, reviewers: [{ name, label, ok, score }], url, error, text }`. `pr` is 0 for local reviews.
- Every channel runs in parallel with a 10-second timeout. A failure is logged and never fails the review.

## 4. Pre-push hook

```sh
review-relay hook install [--min-score N] [--base REF] [--route NAME | --reviewers ids] [--config PATH]
review-relay hook uninstall
```

- Writes `pre-push` into `git rev-parse --git-path hooks` of the checkout it runs in, which follows `core.hooksPath`. Linked worktrees share it with their main checkout.
- `--min-score` defaults to 4. The other flags are passed through to `review`.
- The hook calls review-relay by absolute path (the binary, or `bun` and `src/cli.ts` from a checkout), since GUI git clients often run hooks without `~/.local/bin` on PATH.
- For each pushed branch (`refs/heads/*`, not a deletion), the hook skips it when every commit on it is already on a remote (`git rev-list "$sha" --not --remotes` is empty), else runs `review --head <sha> --head-name <branch> --min-score N` with stdin closed. Any review that fails or scores under the threshold blocks the push. `git push --no-verify` skips the hook.
- A `pre-push` review-relay did not write is never touched: install refuses and prints the line to add to it. Reinstalling replaces review-relay's own hook, so flags can change. `uninstall` removes only review-relay's hook. Ours is recognized by its marker comment.

## Testing

- Config: defaults, `true` shorthand, bad `minScore`, the `inlineComments` warning, `notify` validation.
- Schema: `parseVerdict` keeps valid `endLine`/`replacement` and drops invalid ones; merge keeps the first and adopts only on the same line.
- Commit status: the state and description for each outcome, at and either side of `minScore`.
- Inline: which findings qualify (new vs open, added vs context lines, contiguous range), suggestion fencing when the replacement holds backticks, the same-commit dedupe, and the runner posting nothing when the PR moved on.
- Notifications: which outcomes notify for each `on`, the payload, and that a channel failure is swallowed.
- Hook: install into a temp repo, `core.hooksPath`, refusing a foreign hook, reinstall, uninstall, and running the hook script with a fake review-relay against pushed-ref stdin.
- Manually: the WSL toast on this machine; the status and inline review against a real PR only with the owner's approval.
