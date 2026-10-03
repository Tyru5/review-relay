# review-relay

Runs local Codex and Claude reviews on a pull request as soon as a review starts on GitHub, then posts their findings and a 1-5 merge confidence score to the PR.

- Repos with Greptile: triggers on Greptile's `Greptile Review` check run starting (`check_run` `created`, `in_progress`).
- Repos without an AI reviewer bot: triggers on GitHub `pull_request` events, the same ones Greptile reacts to.
- Any repo: a PR comment containing `@review-relay` from an owner, member, or collaborator requests a review.

Events reach your machine through `gh webhook forward`, so no public URL is needed.

## Requirements

- `git`
- `gh` signed in with access to the watched repos, plus the webhook extension: `gh extension install cli/gh-webhook`
- `codex` and `claude` CLIs signed in
- A local clone of each watched repo
- [Bun](https://bun.sh), only when running from source

## Install

macOS / Linux (installs to `~/.local/bin`):

```sh
curl -fsSL https://downloads.reviewrelay.dev/install.sh | bash
```

Windows PowerShell (installs to `%LOCALAPPDATA%\review-relay\bin` and adds it to your user PATH):

```powershell
irm https://downloads.reviewrelay.dev/install.ps1 | iex
```

The installers download a standalone binary (no Bun needed) for your OS and CPU, verify it against the release's `SHA256SUMS`, and seed `~/.review-relay/config.json` from `config.example.json` if it does not exist. Rerun to update. Pin a version with `bash -s -- --version 0.2.0` (PowerShell: `-Version 0.2.0`, see the script header). Supported: macOS and glibc Linux on x64 and arm64, Windows x64.

Then edit `~/.review-relay/config.json` and run `review-relay start`.

## Setup from source

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
| `models.claude` | `{"model": "claude-opus-5-5", "effort": "max"}` | Model and effort for the Claude reviewer (`--model`, `--effort`) |
| `models.codex` | `{"model": "gpt-6-astra", "effort": "high"}` | Model and reasoning effort for the Codex reviewer (`--model`, `model_reasoning_effort`) |
| `dataDir` | `~/.review-relay` | State, reports, and temporary worktrees |
| `repos[].fullName` | required | `owner/name` |
| `repos[].localPath` | required | Local clone used to create worktrees |
| `repos[].trigger` | `auto` | `auto`, `greptile`, or `github` (see below) |
| `repos[].postToPr` | `true` | Post the scored review as one PR comment (edited in place on later reviews) |
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
bun src/cli.ts status [--limit N]                   # recent jobs: scores, per-reviewer timings, finding counts
bun src/cli.ts config                               # resolved config as JSON
```

## Development

```sh
bun run check          # typecheck, lint:check, fmt:check, tests
bun run lint           # oxlint --fix (.oxlintrc.json); lint:check to verify
bun run fmt            # oxfmt (.oxfmtrc.json); fmt:check to verify
bun run ci:local       # run the CI workflow locally with act (cached image)
bun run ci:local:pull  # same, pulling the latest runner image first
```

The landing page at [reviewrelay.dev](https://reviewrelay.dev) lives in `site/` (TanStack Start, deployed by Vercel on push to `main` only, since `site/vercel.json` turns off preview deployments for other branches; brand assets come from `assets/`). From the repo root: `bun run site:dev` (http://127.0.0.1:3000), `bun run site:build`, `bun run site:preview`, and `bun run site:tunnel` to share the dev server through a temporary Cloudflare quick tunnel.

## Releasing

Releases are standalone binaries built with `bun build --compile` and served from the `review-relay-downloads` R2 bucket at `https://downloads.reviewrelay.dev`:

```
install.sh, install.ps1                        installers (no-cache)
latest.txt                                     latest version, uploaded last
v<version>/review-relay-<os>-<arch>[.exe]      immutable binaries
v<version>/SHA256SUMS, config.example.json
```

To release, bump `version` in `package.json`, merge, then push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the checks, rejects a tag that does not match `package.json`, builds all targets, and uploads with wrangler. It needs the `CLOUDFLARE_API_TOKEN` secret (an account API token with R2 Storage edit access) and the `CLOUDFLARE_ACCOUNT_ID` repo variable. `bun run release:build` stages the same files in `dist/` without uploading; `bun run release` uploads from a clean tree with your local `wrangler login`.

## Daemon control

```sh
scripts/relay start      # background daemon; pid + log in dataDir (daemon.pid, daemon.log)
scripts/relay stop       # SIGTERM so temporary repo webhooks get deleted; forces after 20s
scripts/relay restart
scripts/relay status     # daemon, health, forwarders, recent jobs (exit 3 if stopped)
scripts/relay info       # resolved config incl. defaults; flags edits not yet applied; --json for raw
scripts/relay logs [N|-f]
```

Also available as `bun run relay:<command>` (e.g. `bun run relay:logs -f`). Needs `jq`.

Reports land in `~/.review-relay/reports/<owner>__<repo>/pr-<n>/<sha>/` as `comment.md`, `codex.json`, `claude.json`, and `meta.json`.

## How a review runs

1. Fetch `refs/pull/<n>/head` and the base branch into the local clone.
2. Create a detached worktree at the PR head commit.
3. Compute diff stats (files, lines, test files touched, wide-impact files such as lockfiles, CI, migrations, schemas).
4. Run both reviewers in parallel with the same rubric prompt and a JSON schema for the answer, both read-only:
   - `codex exec --sandbox read-only --output-schema ...`
   - `claude -p --json-schema ...` with only `Read`, `Grep`, `Glob`, and `git diff/log/show/grep` allowed
5. Write reports, post or update the PR comment, remove the worktree.

Reviewers are spawned directly, not through your shell, so shell aliases (for example a `codex` alias that bypasses the sandbox) do not apply.

## Confidence score

Each reviewer reads the repo's own standards (AGENTS.md, CLAUDE.md, CONTRIBUTING, Greptile rules, lint configs, neighboring code), searches for callers of changed code, and scores six dimensions from 1 to 5:

| Dimension | What it measures |
| - | - |
| Correctness | Bugs, edge cases, error handling, races, data loss |
| Security | Injection, auth, secrets, unsafe input, risky dependencies |
| Code quality | Readability, structure, duplication, complexity, dead code |
| Standards | The repo's documented conventions plus industry practice for the stack |
| Blast radius | How much other code depends on what changed (5 = isolated, 1 = shared core, public API, schema, or config) |
| Testing | Whether changed behavior is covered by meaningful tests |

The reviewer also gives an overall merge confidence (5 = merge as is, 4 = minor issues, 3 = fix before merging, 2 = critical issue or wide blast radius with weak tests, 1 = should not merge). Code then applies caps so the number matches the findings: a critical finding limits it to 2, a major finding to 3, and it can be at most one above the weakest dimension.

The PR comment headline is the lowest score among reviewers that succeeded. It also shows each reviewer's score, the dimension table, findings merged across reviewers (with links to the exact lines at the reviewed commit), and dimension notes. Local copies land in the report directory as `comment.md`, `codex.json`, `claude.json`, and `meta.json`.

## Limits

- `gh webhook forward` is GitHub's development tool: one forwarder per repo at a time, and the machine must be online. Stop the daemon with Ctrl+C so it removes the temporary repo webhooks.
- Fetching creates `refs/review-relay/pr-<n>` refs in your local clone.
