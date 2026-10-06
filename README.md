# review-relay

Runs local AI agent reviews (Claude Code, Codex, or any of 11 other agent CLIs) on a pull request as soon as a review starts on GitHub, then posts their findings and a 1-5 merge confidence score to the PR.

- Repos with Greptile: triggers on Greptile's `Greptile Review` check run starting (`check_run` `created`, `in_progress`).
- Repos without an AI reviewer bot: triggers on GitHub `pull_request` events, the same ones Greptile reacts to.
- Any repo: a PR comment containing `@review-relay` from an owner, member, or collaborator requests a review.

Events reach your machine through `gh webhook forward`, so no public URL is needed.

## Requirements

- `git`
- `gh` signed in with access to the watched repos, plus the webhook extension: `gh extension install cli/gh-webhook`
- At least one [supported agent CLI](#supported-agents), signed in (Claude Code and Codex by default)
- A local clone of each watched repo
- [Bun](https://bun.sh), only when running from source

## Install

macOS / Linux (installs to `~/.local/bin`):

```sh
curl -fsSL https://github.com/Tyru5/review-relay/releases/latest/download/install.sh | bash
```

Windows PowerShell (installs to `%LOCALAPPDATA%\review-relay\bin` and adds it to your user PATH):

```powershell
irm https://github.com/Tyru5/review-relay/releases/latest/download/install.ps1 | iex
```

The installers download a standalone binary (no Bun needed) for your OS and CPU, verify it against the release's `SHA256SUMS`, seed `~/.review-relay/config.json` from `config.example.json` if it does not exist, and add `rr` as a shortcut for `review-relay` (skipped if an unrelated `rr` is already there; opt out with `--no-alias` / `-NoAlias`). Rerun to update. Pin a version with `bash -s -- --version 0.6.0` (PowerShell: `-Version 0.6.0`, see the script header). Supported: macOS and glibc Linux on x64 and arm64, Windows x64.

Then edit `~/.review-relay/config.json` and run `review-relay start`.

## Setup from source

```sh
bun install
mkdir -p ~/.review-relay
bun src/cli.ts setup                                 # pick repos, reviewers, and models in a terminal UI
# or: cp config.example.json ~/.review-relay/config.json, then edit repos
bun src/cli.ts start
```

## Config

`bun src/cli.ts setup` (or `scripts/relay setup`) walks through the config step by step in the terminal. The first step picks the repos to watch (↑/↓ to move, space to toggle, `/` to filter by name or path, enter to continue): it lists the repos the config already names, then every GitHub clone it finds up to four folders deep under your home folder (hidden folders, `node_modules`, and build output are skipped), and `other` takes the path of a clone anywhere else. The configured repos start selected, or, for a new config, the clone setup was run from. A configured repo whose clone is no longer at its path is moved to the clone when that is unambiguous (the clone setup was run from, or the only one found); otherwise it stays selected with a warning, and typing its new path under `other` moves it. A new repo is saved with just `fullName` and `localPath`, so it gets the defaults below (`auto` trigger, posting to the PR); a repo already in the config keeps its entry as it was (with the new path when it moved), and one toggled off is removed. The next step lists the supported agent CLIs it finds on PATH, plus any the config already names and its [custom reviewers](#custom-reviewers), and picks which ones review PRs. Claude Code and Codex start selected when installed. Then each selected reviewer gets a step that picks its model and, for CLIs that take one, a step that picks its reasoning effort: a list of values the CLI accepts with the current one highlighted, or `other` to type any value. Picking the default clears that field in the file, except that a file which already pins the default value keeps it. The last step shows what changed and saves it to the config file, creating the file if it doesn't exist. Fields the steps don't cover, such as `provider` and each repo's `trigger`, are kept.

| Field | Default | Meaning |
| - | - | - |
| `port` | `9988` | Local port for forwarded webhooks |
| `graceMs` | `120000` | In `auto` mode, how long a GitHub PR event waits for Greptile before running anyway |
| `timeoutMs` | `1800000` | Per-reviewer timeout |
| `reviewers` | `["codex", "claude"]` | Which reviewers run, by the names under [Supported agents](#supported-agents) or the ids of [custom reviewers](#custom-reviewers) |
| `models.<id>` | see below | `model` and `effort` for that reviewer's CLI, passed with the flags listed under Supported agents. Unset means review-relay's default for that CLI, below, and otherwise the CLI's own default. `provider` is also read for `hermes`. |
| `models.<id>.harness` | the id | The CLI a [custom reviewer](#custom-reviewers) runs |
| `models.<id>.label` | the CLI's name, or the custom id | The reviewer's name in the PR comment |
| `models.claude` | `{"model": "claude-opus-5-5", "effort": "max"}` | |
| `models.codex` | `{"model": "gpt-6-astra", "effort": "high"}` | |
| `routes` | none | Rules that pick the reviewers for each PR; see [Routing](#routing) |
| `dataDir` | `~/.review-relay` | State, reports, and temporary worktrees |
| `repos[].fullName` | required | `owner/name` |
| `repos[].localPath` | required | Local clone used to create worktrees |
| `repos[].trigger` | `auto` | `auto`, `greptile`, or `github` (see below) |
| `repos[].postToPr` | `true` | Post the scored review as one PR comment (edited in place on later reviews) |
| `repos[].github.onPush` | `false` | Review new commits pushed to an open PR (`synchronize`) |
| `repos[].github.mention` | `@review-relay` | Comment text that requests a review |

### Custom reviewers

A key in `models` that isn't a CLI name defines a custom reviewer. Its `harness` names the CLI it runs, so one CLI can review with two models, even on the same PR:

```json
"reviewers": ["claude", "haiku"],
"models": {
  "haiku": { "harness": "claude", "model": "claude-haiku-4-5", "label": "Haiku" }
}
```

- Ids use lowercase letters, digits, and dashes, up to 32 characters. Each id gets its own report file and `status` column.
- Unset settings fall back to the CLI's defaults and never to another entry. `haiku` above runs at the claude default effort, `max`, whatever `models.claude` says.
- The reviewers in `reviewers` need different labels.
- `setup` lists custom reviewers next to the CLIs and edits their model and effort. Adding or removing one happens in the file.

A mistake in a custom entry stops the config from loading: an unknown setting, a `harness` that isn't a supported CLI, an `effort` for a CLI without one, or a `provider` for anything but hermes. In an entry named after a CLI, an unknown setting, a stray `effort`, or a stray `provider` only prints a warning and is ignored, as before, so configs that loaded still load.

### Routing

Without `routes`, every PR gets the same `reviewers`. Routes pick the reviewers for each PR from what git and GitHub report about it: the repo, the base branch, the trigger, which files changed, and how much. They are optional; a config without them works as it always has.

```json
"reviewers": ["codex", "claude"],
"models": { "haiku": { "harness": "claude", "model": "claude-haiku-4-5", "label": "Haiku" } },
"routes": [
  { "name": "docs", "when": { "onlyPaths": ["docs/**"] }, "skip": true },
  { "name": "risky", "when": { "wideImpact": true }, "reviewers": ["claude", "codex"], "timeoutMs": 3600000 },
  { "name": "tiny", "when": { "maxLines": 30, "wideImpact": false }, "reviewers": ["haiku"] },
  { "name": "side", "when": { "repos": ["Tyru5/side-*"] }, "reviewers": ["haiku"] }
]
```

review-relay checks routes from the top. The first route whose `when` matches decides the review, and `reviewers` runs when none match. Order is precedence: here a risky change in a side project still gets Claude and Codex.

| Field | Meaning |
| - | - |
| `name` | Required and unique: lowercase letters, digits, and dashes. Shown in the PR comment, `status`, and logs. |
| `when` | At least one condition. Every condition must hold; a condition that takes a list matches when any item does. |
| `reviewers` | Reviewer ids to run, CLI names or [custom reviewers](#custom-reviewers) |
| `skip` | `true` skips the review. A route sets exactly one of `reviewers` and `skip`. |
| `timeoutMs` | Per-reviewer timeout for this route, in place of the global `timeoutMs` |

| Condition | Matches when |
| - | - |
| `repos` | The repo's `owner/name` matches one of these globs, ignoring case. Each must match a configured repo. |
| `baseBranches` | The base branch matches one of these globs, such as `release/*` |
| `sources` | The trigger is one of `greptile`, `github`, `mention`, `manual` (`run`) |
| `paths` | Any changed file matches one of these globs |
| `onlyPaths` | At least one file changed, and every changed file matches one of these globs |
| `minLines`, `maxLines` | Lines added plus deleted, lockfiles left out, are at least or at most this many |
| `minFiles`, `maxFiles` | Changed files, lockfiles left out, are at least or at most this many |
| `wideImpact` | `true`: a wide-impact file changed, such as a manifest, lockfile, CI file, migration, or schema. `false`: none did. |

Globs work like GitHub Actions `paths:` filters: `*.md` matches only root files, `**/*.md` matches at any depth, and paths are case-sensitive. A renamed file matches on its old and new paths, and `onlyPaths` needs both, so moving `src/x.ts` to `docs/x.md` is not a docs-only change. Lockfiles (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, and the like) don't count toward size, so a dependency bump with 20 lines of code counts as 20 lines. They still count as wide-impact.

A skip route reviews nothing and posts nothing; `status` shows the commit as `skipped`. Skip routes are guarded:

- They may only use `onlyPaths`, `repos`, `baseBranches`, and `sources`. A skip on `paths` would skip code that changed next to docs, and a skip on size would let a small change through unreviewed, so the config won't load. Send small PRs to a cheap route instead.
- A mention or `run` never skips: they go on to the next route that matches, or to `reviewers`.
- A PR that changes an agent file is never skipped: AGENTS.md, CLAUDE.md, or GEMINI.md at any depth, `.github/copilot-instructions.md`, `.cursorrules`, `.claude/`, `.cursor/`, and every path listed under [Supported agents](#supported-agents) as deleted for a CLI. These files steer coding agents, and review-relay's own reviewers read them as the repo's standards.

A mention can name a route: `@review-relay risky` runs the `risky` route whatever its `when` says. Any other word after the mention gets normal routing. `run --route risky` does the same from the command line.

When the config has routes, the PR comment gets a second line under the headline with the route and why it matched, then each reviewer's model and effort:

```
Route `risky` (wide-impact: bun.lock, .github/workflows/ci.yml) · Claude: claude-opus-5-5, max · Codex: gpt-6-astra, high
```

`review-relay route --repo owner/name --pr 123` shows which route a PR matches and why, without reviewing it. It fetches the PR, checks every route, and prints the first condition each failed. It works on closed and merged PRs too, so you can try rules on past PRs. `--source mention` shows what a mention would get.

A config error in a route names it, such as `routes[1] "tiny": skip can't use maxLines`. `config` prints the routes as parsed, and `info` lists them.

### Trigger modes

- `auto`: a Greptile start runs immediately. A GitHub PR event (opened, reopened, ready for review) waits `graceMs`; if Greptile starts on that commit first, Greptile's start is used, otherwise the GitHub event runs. Use this for repos that have Greptile, so reviews still happen when Greptile skips a PR, is down, or the PR comes from a fork.
- `greptile`: only Greptile starts (plus mentions).
- `github`: only GitHub PR events (plus mentions). Use this for repos with no AI reviewer bot.

Each commit is reviewed once. Mentions and `run` always review again. Drafts are skipped until marked ready.

## Supported agents

PR content can carry prompt injection, so every reviewer runs headless and locked down by the CLI itself, not by asking nicely in the prompt: no file writes, no web access, and no shell. Codex is the exception: its commands run inside its read-only OS sandbox. Vibe's plan agent may also run `git diff` and `git log` because it refuses the git flags that write files or run programs. Every other reviewer gets the commit list and diff (up to 60,000 characters) in the prompt instead. CLIs without a schema flag get the verdict schema in the prompt, and review-relay parses the JSON out of their reply.

Several CLIs run code from config files in the repo they're reviewing (hooks, plugins, MCP servers). Before any reviewer starts, review-relay deletes those paths from the review worktree for the selected CLIs. The PR's changes to them still show in the diff.

| Reviewer | CLI | Locked down with | `models` flags |
| - | - | - | - |
| `claude` | Claude Code | `--restricted --strict-mcp-config --permission-mode dontAsk`, tools `Read,Grep,Glob`; ignores user, project, and local settings | `--model`, `--effort` |
| `codex` | Codex CLI | `exec --sandbox read-only --ignore-user-config --ignore-rules` | `--model`, `model_reasoning_effort` |
| `auggie` | Augment Auggie | lists its tools each run and removes all but read and search; fresh cache dir with the login passed in `AUGMENT_SESSION_AUTH`; deletes `.augment/` | `-m`, `--reasoning-effort` |
| `copilot` | GitHub Copilot CLI | `--available-tools view,read,grep,glob`, `--deny-tool write`, `--deny-tool shell`, `--no-custom-instructions`, `--disable-builtin-mcps`; deletes `.github/hooks/`, `.github/copilot/`, `.mcp.json`, `.vscode/mcp.json` | `--model`, `--reasoning-effort` |
| `droid` | Factory Droid | `exec` (read-only unless `--auto`) with `--only-tools Read,Grep,Glob,LS`; deletes `.factory/` | `-m`, `-r` |
| `gemini` | Gemini CLI | `--approval-mode plan`, `-e none`, no MCP servers; deletes `.gemini/`, `.env` | `-m` |
| `grok` | Grok Build | tools `read_file,grep,list_dir`; no web search, subagents, memory, MCP, or Claude Code and Cursor imports; deletes `.grok/`, `.envrc` | `-m`, `--reasoning-effort` |
| `hermes` | Hermes Agent | `-z --safe-mode` with the `file` toolset and writes confined to an empty scratch directory; deletes `.hermes/` | `-m`, `--provider`, `--reasoning` |
| `kilo` | Kilo Code CLI | `run --pure` with an inline read-only agent, project config off, never through a daemon; deletes `.kilo/`, `.kilocode/`, `kilo.json`, `opencode.json` | `-m`, `--variant` |
| `opencode` | opencode | `run --pure` with an inline read-only agent and project config off; deletes `.opencode/`, `opencode.json` | `-m`, `--variant` |
| `pi` | pi | `-p --tools read,grep,find,ls` with no extensions, skills, or context files, ignoring project-local files; deletes `.pi/` | `--model`, `--thinking` |
| `qwen` | Qwen Code | `--approval-mode plan --safe-mode`; deletes `.qwen/` | `-m` |
| `vibe` | Mistral Vibe | `-p --agent plan`, which denies anything that needs approval; deletes `.vibe/`, `.agents/` | model alias via `VIBE_ACTIVE_MODEL` |

Each lockdown was checked on macOS by asking the agent to write a file, run `touch`, and fetch a URL. Copilot, Gemini, and Qwen were set up from their docs and source but not run, because they weren't installed. Droid's login failed on the test machine, so only its offline tool listing was checked. Kilo was probed, but its review run needs account credits.

Not supported, because a PR could get around the lockdown:

- Amp: its permission rules don't block its web tools, and it reads files only through a shell whose allow patterns let `git log; touch x` through.
- Cursor CLI: runs commands from a PR's `.cursor/hooks.json` under every flag combination.
- Devin CLI: runs hooks and MCP servers from a PR's `.devin/` before tool limits apply.
- Cline: runs a PR's `.cline/hooks/` and plugins, with no way to turn that off.
- Goose: runs hooks from a PR's `.agents/plugins/`, and recipes render the prompt as a template.
- Crush: `crush run` approves every tool, and a PR's `crush.json` runs shell at load.
- Aider: edits files by design, with no tool sandbox.
- Kiro CLI: auto-allows `git diff` and `git log`, which can write files with `--output`; it's closed source, so how it handles those flags couldn't be checked.
- OpenHands: headless mode approves every action.

Not evaluated yet: Continue (`cn`), Kimi Code, Letta Code, Qoder, CodeBuddy, Docker Agent, iFlow, JetBrains Junie, Qodo Command.

## Commands

Installed binary (`review-relay`) or repo checkout (`bun src/cli.ts`); both take the same commands:

```sh
review-relay start                                  # watch all configured repos in the foreground
review-relay start -d                               # same, as a background daemon (pid + log in dataDir)
review-relay stop                                   # SIGTERM so temporary repo webhooks get deleted; forces after 20s
review-relay restart                                # stop, then start -d
review-relay status [--limit N] [--page N]          # daemon (pid, uptime, endpoint, health), forwarders, jobs (20/page); exit 3 if stopped
review-relay tui                                    # live job list; enter opens a job, r re-reviews, o opens the PR, / filters
review-relay logs [N] [-f]                          # last N daemon log lines (default 50); -f follows
review-relay run --repo owner/name --pr 123         # review an open PR now
review-relay run --repo owner/name --pr 123 --route risky   # ... with this route
review-relay route --repo owner/name --pr 123       # which route a PR matches and why, without reviewing
review-relay replay events.jsonl --dry-run          # test trigger logic with recorded deliveries
review-relay info                                   # resolved config with defaults; flags edits the daemon has not loaded
review-relay config                                 # resolved config as JSON (info --json)
review-relay setup                                  # interactive config: pick repos, reviewers, and models, then save
```

Colors follow `NO_COLOR` / `FORCE_COLOR` and whether stdout is a terminal. `review-relay --help` groups the commands with examples.

`review-relay tui` takes over the terminal with the job table in a panel on top, the highlighted job's detail in a panel below it, and the daemon's state in the status line, refreshing as the daemon writes `state.json`. Enter expands a job: its score, each reviewer's score, model, and time, the merged findings with their file and line, and the comment that was posted (or the job's daemon log lines while it runs or after it fails). `l` follows a job's log lines, `L` the whole log, `/` filters by repo, PR, commit, status, source, route, or error text, and `s` cycles the status filter. `r` reviews the PR again (it asks first, then runs `review-relay run` in the background and logs to `daemon.log`), `o` opens the PR in the browser, `y` copies its URL, and `?` lists every key. The TUI reads the same files `status` does, so it works whether or not the daemon is running.

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

Releases are standalone binaries built with `bun build --compile` and attached to a [GitHub Release](https://github.com/Tyru5/review-relay/releases) per `v<version>` tag:

```
review-relay-<os>-<arch>[.exe]   binaries
SHA256SUMS, config.example.json  verified and seeded by the installers
install.sh, install.ps1          installers; releases/latest/download/ always serves the newest
```

The installers resolve `latest` from the redirect GitHub serves at `releases/latest`, then download from `releases/download/v<version>/`. A `-rc.1` style version is published as a pre-release, which `releases/latest` skips.

To release, bump `version` in `package.json`, merge, then push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the checks, rejects a tag that does not match `package.json`, builds all targets, and creates the release with `gh` using the workflow's `GITHUB_TOKEN` (no other secrets). It publishes only from the commit the tag points at, so retry a failed run with "Re-run jobs" or `gh workflow run release.yml --ref v0.2.0`. A published release is never modified, since replacing its assets would break installs mid-upload; bump the version to ship a fix. `bun run release:build` stages the same files in `dist/v<version>/` without publishing; `bun run release` publishes from a clean checkout of the tag with your local `gh auth login`.

## Daemon control

The daemon records itself in `<dataDir>/daemon.json` (pid, port, start time, version, and each `gh webhook forward` child), and `status`, `stop`, and `info` read that record, confirm the pid is still a review-relay process, and ping `GET /health`. `/health` also returns the daemon's pid and version in `x-review-relay-pid` / `x-review-relay-version` headers, so a daemon whose record is missing or fails the start-time check is still recognized, and `status` flags a daemon older than the installed CLI. Logs from `start -d` go to `<dataDir>/daemon.log`.

From a repo checkout, `scripts/relay <command>` (also `bun run relay:<command>`) forwards to `bun src/cli.ts <command>`, with `start` running in the background.

Reports land in `~/.review-relay/reports/<owner>__<repo>/pr-<n>/<sha>/` as `comment.md`, one `<id>.json` per reviewer, and `meta.json`.

## How a review runs

1. Fetch `refs/pull/<n>/head` and the base branch into the local clone.
2. Compute diff stats in the clone (files, lines, test files touched, wide-impact files such as lockfiles, CI, migrations, schemas).
3. Pick the route (see [Routing](#routing)). A skip route stops here, before any worktree exists.
4. Create a detached worktree at the PR head commit.
5. Delete the config paths a PR could use to run code through the selected CLIs (see [Supported agents](#supported-agents)).
6. Run the route's reviewers in parallel with the same rubric prompt, each locked down as listed above. `start` logs a warning for any reviewer, in `reviewers` or a route, whose CLI isn't on PATH.
7. Write reports, post or update the PR comment, remove the worktree.

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

The PR comment headline is the lowest score among reviewers that succeeded. It also shows each reviewer's score, the dimension table, findings merged across reviewers (with links to the exact lines at the reviewed commit), and dimension notes. Local copies land in the report directory as `comment.md`, one `<id>.json` per reviewer, and `meta.json`.

## Limits

- `gh webhook forward` is GitHub's development tool: one forwarder per repo at a time, and the machine must be online. Stop the daemon with Ctrl+C so it removes the temporary repo webhooks.
- Fetching creates `refs/review-relay/pr-<n>` refs in your local clone.
- Most reviewers can read files outside the worktree, so a prompt-injected reviewer could quote one, such as a credentials file, into findings that get posted to the PR. Claude Code (`--restricted`) and Copilot keep reads inside the worktree; Codex's sandbox blocks writes and network but not reads.
- Your own user-level hooks still run for Grok and Vibe, which have no flag to skip them.
- Someone can game a size route by splitting a change into small PRs, so a cheap route on `maxLines` sees each piece alone. Skip routes pass over PRs that change agent files, but a cheap route still matches them: keep `**/*.md` out of routes that downgrade, and prefer `docs/**`.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
