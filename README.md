# review-relay

Runs local Codex and Claude reviews on a pull request as soon as a review starts on GitHub.

- Repos with Greptile: triggers on Greptile's `Greptile Review` check run starting (`check_run` `created`, `in_progress`).
- Repos without an AI reviewer bot: triggers on GitHub `pull_request` events, the same ones Greptile reacts to.
- Any repo: a PR comment containing `@review-relay` from an owner, member, or collaborator requests a review.

Events reach your machine through `gh webhook forward`, so no public URL is needed.

## Requirements

- [Bun](https://bun.sh)
- `gh` signed in with access to the watched repos, plus the webhook extension: `gh extension install cli/gh-webhook`
- `codex` and `claude` CLIs signed in
- A local clone of each watched repo

## Setup

```sh
bun install
mkdir -p ~/.review-relay
cp config.example.json ~/.review-relay/config.json   # then edit repos
bun src/cli.ts start
```

## Config

| Field | Default | Meaning |
| - | - | - |
| `port` | `9988` | Local port for forwarded webhooks |
| `graceMs` | `120000` | In `auto` mode, how long a GitHub PR event waits for Greptile before running anyway |
| `timeoutMs` | `1800000` | Per-reviewer timeout |
| `reviewers` | `["codex", "claude"]` | Which reviewers to run |
| `dataDir` | `~/.review-relay` | State, reports, and temporary worktrees |
| `repos[].fullName` | required | `owner/name` |
| `repos[].localPath` | required | Local clone used to create worktrees |
| `repos[].trigger` | `auto` | `auto`, `greptile`, or `github` (see below) |
| `repos[].postToPr` | `false` | Also post both reviews as one PR comment |
| `repos[].github.onPush` | `false` | Review new commits pushed to an open PR (`synchronize`) |
| `repos[].github.mention` | `@review-relay` | Comment text that requests a review |

### Trigger modes

- `auto`: a Greptile start runs immediately. A GitHub PR event (opened, reopened, ready for review) waits `graceMs`; if Greptile starts on that commit first, Greptile's start is used, otherwise the GitHub event runs. Use this for repos that have Greptile, so reviews still happen when Greptile skips a PR, is down, or the PR comes from a fork.
- `greptile`: only Greptile starts (plus mentions).
- `github`: only GitHub PR events (plus mentions). Use this for repos with no AI reviewer bot.

Each commit is reviewed once. Mentions and `run` always review again. Drafts are skipped until marked ready.

## Commands

```sh
bun src/cli.ts start                                # watch all configured repos
bun src/cli.ts run --repo owner/name --pr 123       # review an open PR now
bun src/cli.ts replay events.jsonl --dry-run        # test trigger logic with recorded deliveries
bun src/cli.ts status                               # recent jobs and report paths
```

Reports land in `~/.review-relay/reports/<owner>__<repo>/pr-<n>/<sha>/` as `codex.md`, `claude.md`, and `meta.json`.

## How a review runs

1. Fetch `refs/pull/<n>/head` and the base branch into the local clone.
2. Create a detached worktree at the PR head commit.
3. Run in parallel, both read-only:
   - `codex review --base origin/<base>` with `sandbox_mode="read-only"`
   - `claude -p` with only `Read`, `Grep`, `Glob`, and `git diff/log/show` allowed
4. Write reports, optionally comment on the PR, remove the worktree.

Reviewers are spawned directly, not through your shell, so shell aliases (for example a `codex` alias that bypasses the sandbox) do not apply.

## Limits

- `gh webhook forward` is GitHub's development tool: one forwarder per repo at a time, and the machine must be online. Stop the daemon with Ctrl+C so it removes the temporary repo webhooks.
- Fetching creates `refs/review-relay/pr-<n>` refs in your local clone.
