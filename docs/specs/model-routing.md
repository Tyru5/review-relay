# Model routing

Status: approved. Ships as two stacked PRs, `feat/reviewer-ids` and then `feat/model-routing`.

## Why

Every PR gets the same reviewers today. `reviewers` lists CLIs, and `models.<cli>` sets one model and effort per CLI for every repo and every PR. A typo fix costs an Opus-max run and a Codex-high run. A migration gets no more scrutiny than a README edit. A side project pays what a work repo pays.

Routing picks the reviewers for each PR from facts review-relay already has: the repo, the base branch, what triggered the review, which files changed, and how much. It is opt-in. A config without `routes` or custom reviewers behaves as it does today.

## Goals

- Cheaper, faster reviews for small or low-risk PRs.
- More reviewers, stronger models, or longer timeouts for risky PRs.
- Different reviewers per repo.
- One CLI on different models, in different routes or side by side on one PR.

## Non-goals

- New LLM tasks such as verifying findings, writing the comment, or triage. Review stays the only task, and the config leaves room to add tasks later.
- Letting a model pick the route. A PR's own text could talk a triage model into choosing the weakest reviewer, so routes match only on facts git and GitHub report.
- Author and label conditions. Greptile's check run payload has neither, so they would cost an extra `gh pr view` per job. They can come later.
- Editing routes or creating custom reviewers in `setup`.
- Per-reviewer timeouts, falling back to another reviewer when one fails, and reloading the config without a restart.
- Updating the site and PRODUCT.md. That gets its own PR after the release.

## Opt-in guarantee

With no `routes` and no custom `models` keys:

- The same reviewers run on the same models.
- The PR comment and `status` look as they do today. `meta.json` gains fields and loses none.
- Every config that loads today still loads, except `"reviewers": []`. That one loads today but fails every review, so it becomes a load error.
- Problems in today's config shapes print warnings. Strict errors cover only the new fields, listed under Validation.

One change reaches everyone. Changed files now come from `git diff --numstat -z`, which fixes how renamed files are counted. See Changed files.

## Config

### Reviewer entries

Each key in `models` is now a reviewer id. The 13 CLI names are ids without needing an entry. A custom id names its CLI in `harness`.

```json
"reviewers": ["claude", "codex"],
"models": {
  "claude": { "model": "claude-opus-5-5", "effort": "max" },
  "codex": { "model": "gpt-6-astra", "effort": "high" },
  "haiku": { "harness": "claude", "model": "claude-haiku-4-5", "label": "Haiku" },
  "oc-sol": { "harness": "opencode", "model": "openai/gpt-6-sol" }
}
```

| Field | Applies to | Meaning |
| - | - | - |
| `harness` | Custom ids, required | The CLI that runs the review, one of the names under Supported agents in the README. A CLI-named entry may leave it out or repeat its own name. |
| `model` | Every entry | As today. Unset falls back to review-relay's default for that CLI, `claude-opus-5-5` for claude and `gpt-6-astra` for codex, and otherwise to the CLI's own default. |
| `effort` | CLIs with an effort setting | As today. gemini, qwen, and vibe have none. |
| `provider` | hermes | As today. |
| `label` | Every entry | Name in the PR comment. Defaults to the id for custom entries and to the product label, such as "Claude", for CLI names. |

Entries are self-contained. Unset fields fall back to the CLI's defaults and never to another entry, so editing `models.claude` doesn't change `haiku`.

`reviewers` lists the ids that review a PR when no route matches, and it may name custom ids. One CLI can appear under several ids. Each id gets its own scratch directory, report file `<id>.json`, and `status` column. An entry that nothing uses yet is fine.

Ids match `^[a-z0-9][a-z0-9-]{0,31}$` because they become file names and column headers. A CLI name can't point its `harness` at a different CLI. Labels must be unique, ignoring case, among the reviewers that `reviewers` or a route uses.

### Routes

```json
"routes": [
  { "name": "docs", "when": { "onlyPaths": ["docs/**"] }, "skip": true },
  { "name": "risky", "when": { "wideImpact": true }, "reviewers": ["claude", "codex"], "timeoutMs": 3600000 },
  { "name": "tiny", "when": { "maxLines": 30, "wideImpact": false }, "reviewers": ["haiku"] },
  { "name": "side", "when": { "repos": ["Tyru5/side-*"] }, "reviewers": ["haiku"] }
]
```

review-relay checks routes from the top. The first route whose `when` matches decides the review, and `reviewers` runs when none match. Order is precedence, so risky routes go above broad ones. In this example a risky change in a side project still gets Claude and Codex.

| Field | Meaning |
| - | - |
| `name` | Required and unique, with the same rules as ids. Shown in the PR comment, `status`, and logs, and used to force the route from a mention. |
| `when` | Required, with at least one condition. Every condition must hold. A condition that takes a list matches when any item matches. |
| `reviewers` | Ids to run. Not empty, no duplicates. |
| `skip` | `true` skips the review. A route sets exactly one of `reviewers` and `skip`. |
| `timeoutMs` | Per-reviewer timeout for this route, in place of the global `timeoutMs`. Not allowed with `skip`. |

| Condition | Type | Matches when |
| - | - | - |
| `repos` | globs | The repo's `owner/name` matches one, ignoring case. |
| `baseBranches` | globs | The PR's base branch matches one. |
| `sources` | list | The trigger is one of `greptile`, `github`, `mention`, `manual`. |
| `paths` | globs | Any changed file matches one. |
| `onlyPaths` | globs | At least one file changed and every changed file matches one. |
| `minLines`, `maxLines` | integer, 0 or more | Counted lines are at least, or at most, this many. |
| `minFiles`, `maxFiles` | integer, 0 or more | Counted files are at least, or at most, this many. |
| `wideImpact` | boolean | `true` when a wide-impact file changed, `false` when none did. |

The Matching section defines changed files, globs, counted lines, and wide impact.

### Skip

A skip route stops the review before anything runs. review-relay creates no worktree, runs no reviewer, and posts nothing. It logs the route and records the job as `skipped`. A relay comment from an earlier commit stays as it was, and that comment names the commit it reviewed. The skipped commit counts as handled, and the next commit gets routed again.

Skip routes may use only `onlyPaths`, `repos`, `baseBranches`, and `sources`. With `paths`, a PR that changes code next to docs would be skipped. With size or `wideImpact`, a small change could merge with no review at all. Both are load errors. Send tiny PRs to a cheap route instead.

A mention or `run` never skips. Both pass over skip routes to the next route that matches, or to `reviewers`, because a person who asks for a review should get one. A skip route whose `sources` holds only `mention` and `manual` could never fire, so it's a load error.

A skip route never matches a PR that changes an agent file, so the PR goes on to the next matching route. Agent files steer coding agents, and review-relay's reviewers read some of them as the repo's standards. A PR that adds "always score 5/5" to AGENTS.md must not merge unreviewed because a docs route matched `**/*.md`. Agent files are:

- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` at any depth, and `.github/copilot-instructions.md`.
- `.cursorrules`, `.windsurfrules`, `.clinerules`, and `.mcp.json`.
- Anything under `.claude/`, `.codex/`, `.cursor/`, `.windsurf/`, `.github/instructions/`, or `.github/prompts/`.
- Every path the runner deletes for a supported CLI, such as `.gemini/` and `.agents/`. The list follows the harnesses' `projectFiles`, so a new harness extends it.

### Forcing a route

A mention such as `@review-relay risky` forces the route named `risky` and ignores its `when`. review-relay reads the first word after the repo's mention text, ignoring case. Any other word gets normal routing with no error, because people write "@review-relay please take another look". The comment's route line shows what ran. Naming a skip route counts as naming no route. Only owners, members, and collaborators can trigger a review by mention, as today.

`review-relay run --repo o/n --pr 12 --route risky` does the same from the CLI. There, an unknown or skip route is an error.

### Validation

Strict errors cover the new parts of the config. The daemon won't start, and each message names the spot, for example `routes[1] "tiny": skip can't use maxLines`.

- Custom entries: an invalid id, a missing or unknown `harness`, a CLI name pointing at another CLI, unknown fields, `effort` for a CLI without an effort setting, `provider` for anything but hermes, empty strings.
- Routes: unknown keys in a route or its `when`, an empty `when`, an empty condition list, a missing, duplicate, or invalid name, both or neither of `reviewers` and `skip`, unknown ids, an id listed twice, `minLines` above `maxLines`, negative numbers, a `timeoutMs` that isn't a positive integer, unknown sources, unbalanced `[` or `{` in a glob, a `repos` pattern that matches no configured repo, and the skip rules above.
- Any id in `reviewers` or a route that is neither a CLI name nor a custom entry. That's an error today as well.
- Two reviewers in use with the same label.
- `"reviewers": []`.

Warnings cover today's shapes. `start`, `run`, `route`, and `config` print them, and the config still loads.

- A `models` key that isn't a CLI name and has no `harness`, such as `"Claude"`. review-relay ignores it, as today.
- An unknown field in a CLI-named entry, such as `"modle"`.
- `effort` for gemini, qwen, or vibe, or `provider` for anything but hermes. Ignored, as today.
- An id listed twice in `reviewers`. review-relay runs it once.

## Matching

### Changed files

review-relay reads changed files with `git diff --numstat -z origin/<base>...<head>` in the local clone, after the fetch and before any worktree exists. With `-z`, git prints both paths of a renamed file. Plain `--numstat` prints `src/{a.test.ts => b.test.ts}`, which today hides renamed files from test-file and wide-impact detection.

A changed file has one path, or two when renamed. A deleted file has its old path.

- `paths` matches when any path of any file matches.
- `onlyPaths` matches when every path of every file matches. Renaming `src/x.ts` to `docs/x.md` is not a docs-only change.

### Globs

Patterns use `Bun.Glob`, the same style as GitHub Actions `paths:` filters. Paths are relative to the repo root and case-sensitive.

| Pattern | Matches | Doesn't match |
| - | - | - |
| `*.md` | `README.md` | `docs/a.md` |
| `**/*.md` | `README.md`, `docs/a/b.md` | `docs/a.mdx` |
| `docs/**` | `docs/a/b.ts` | `src/docs/a.ts` |
| `.github/**` | `.github/workflows/ci.yml` | `github/x.yml` |
| `src/{api,db}/**` | `src/db/x.ts` | `src/ui/x.ts` |

`Bun.Glob` accepts malformed patterns without complaint, so `a[b` just never matches. Validation checks that brackets and braces balance, and `review-relay route` shows which patterns missed.

### Counted lines and files

Counted lines are additions plus deletions. Counted files are the changed files. Both leave out lockfiles, so a dependency bump with 20 lines of code counts as 20 lines, not 5,020. A binary file counts as one file with 0 lines. Bounds are inclusive.

Lockfiles, matched by file name at any depth: `bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `deno.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`, `flake.lock`, `Package.resolved`, `pubspec.lock`, `mix.lock`.

Path conditions still see lockfiles. Only the counts leave them out.

### Wide impact

`wideImpact` uses the existing detector in `src/diffstats.ts`. It flags package manifests and lockfiles, Dockerfiles, tsconfig, `.github/`, migrations, schema files, `.sql`, and `.env`. Lockfiles count here because a dependency change is a supply-chain risk. A dependabot bump hits a `wideImpact: true` route unless a route for dependency files sits above it.

### Repos, base branches, and sources

`repos` globs match `owner/name` ignoring case, so `Tyru5/*` covers every configured repo under Tyru5. Each pattern must match at least one configured repo, which catches typos. `baseBranches` globs match the base branch name, such as `release/*`. `sources` names the trigger: `greptile` for Greptile's check run, `github` for PR events, `mention` for a comment, and `manual` for `run`.

## How a review runs

1. The scheduler dispatches the job as today. A mention carries the word after the mention text as `job.route`, and `run --route` sets it too.
2. Fetch the base branch and `refs/pull/<n>/head` into the clone.
3. Read the changed files and compute diff stats in the clone.
4. Pick the route. A non-skip route named by `job.route` wins. Otherwise the first matching route wins, and otherwise `reviewers` runs. Mentions and `run` pass over skip routes, and skip routes don't match a PR that changes an agent file.
5. On a skip, record the job as `skipped` with the route, log it, and stop.
6. Create the worktree and delete the config paths of the CLIs in the chosen reviewer set.
7. Run those reviewers in parallel. Each gets its entry's model, effort, and provider, and the route's timeout or the global one.
8. Write reports and post or update the PR comment, as today.

Steps 2 and 6 are today's `withWorktree`, split so a skip never creates a worktree. `replay --dry-run` doesn't fetch, so it can't pick routes. It logs what would run, as today.

## Output

### PR comment

When the config has `routes`, the comment gets a second `<sub>` line under the headline.

```
<sub>Route `risky` (wide-impact: bun.lock, .github/workflows/ci.yml) · Claude: claude-opus-5-5, max · Codex: gpt-6-astra, high</sub>
```

A forced route reads "Route `risky` (requested by @login)". When no route matched, the line lists only the models. A reviewer with no model set reads "opencode: default model".

Without `routes` the comment is unchanged. The headline is still the lowest score among the reviewers that ran. Findings merge by reviewer id and display labels, so two Claude entries merge like any two reviewers.

### Reports, state, and status

- Report files are `<id>.json`, which for CLI names is today's file name.
- `meta.json` gains `route`, holding the name, the reason, and whether it was forced, or `null`. Each reviewer gains `harness`, `model`, `effort`, and the timeout it ran with.
- Job records in `state.json` gain `route`. A new `skipped` status counts as handled. Skipped jobs write no report, so `status` reads their route from the job record.
- `status` keeps one column per reviewer id and adds ROUTE after SOURCE. Like NOTE, ROUTE hides when no job shown has one. A skipped job shows `skipped`, its route, and no scores.
- The daemon log names the route and why it matched, such as `PR #12 @ 1a2b3c4d: route docs (onlyPaths: 3 files), skipped`.

### `config` and `relay info`

`config` prints each resolved entry with its harness and label, and the routes. `scripts/relay info` shows the harness next to custom reviewers and lists the routes in order with what each runs.

## The `route` command

```sh
review-relay route --repo Tyru5/Agendex --pr 278 [--source github|greptile|mention|manual]
```

`route` fetches the PR the way a review does, reads the changed files, and checks every route without running a reviewer. `--source` defaults to `github`. It works on closed and merged PRs, so you can test rules against past PRs. `run` still needs an open PR.

```
Tyru5/Agendex #278 @ 1a2b3c4d · base main · source github
12 files, +5340 -25 · counted 11 files, +340 -25 (bun.lock left out)
wide-impact: bun.lock, .github/workflows/ci.yml

  ✗ docs    onlyPaths: src/app.ts matches none of docs/**
  ✔ risky   wideImpact: bun.lock, .github/workflows/ci.yml
  ✗ tiny    maxLines: 365 is over 30
  ✗ side    repos: Tyru5/Agendex matches none of Tyru5/side-*

route risky · timeout 60m
  claude  claude  claude-opus-5-5  max
  codex   codex   gpt-6-astra      high
```

Each route that failed shows its first failing condition. A skip route passed over for an agent file names the file. A route below the winner that also matches is marked as shadowed. With no routes configured, `route` prints the counts and the `reviewers` that every PR gets.

## Setup

You write routes and custom entries by hand, and `setup` keeps them.

- Custom entries appear on the reviewers step with their harness, so you can pick them for `reviewers`. The not-on-PATH warning checks the harness's CLI.
- Their model and effort steps use the harness's lists. Picking the CLI default clears the field, and the entry keeps `harness` and `label`.
- The save step lists the routes, read-only.
- `routes` and every field setup doesn't edit stay as written.

## Docs

- The README's `models` table gains `harness` and `label`. A new Routing section covers routes, conditions, globs, counted lines, skip rules, forcing a route, and the `route` command. Commands gains `route` and `run --route`.
- The README's security notes gain two items. Someone can game a size route by splitting a change into small PRs. Skip routes pass over PRs that change agent files, but a cheap route still matches them, so keep `**/*.md` out of downgrade routes and prefer `docs/**`.
- `config.example.json` stays free of routes. The installers seed new configs from it and JSON has no comments, so an example route would be live for every new user. Route examples go in the README.

## Delivery

**PR 1, `feat/reviewer-ids`.** Custom reviewer entries. Configs without them see no change.

- A `HarnessName` type for the 13 CLIs, with reviewer ids as strings. `ReviewerResult` carries the id and the harness.
- Entry parsing, the split between errors and warnings, and label checks. `loadConfig` returns warnings, and the CLI prints them.
- The runner works by id. It looks up the harness, checks `projectFiles` and shell by harness, and keys scratch directories by id. A `RunnerDeps` seam in the style of `SchedulerDeps` injects harness runs, the git steps, and posting, so `runReview` gets tests.
- Reports, merged findings, and status by id, with labels in the comment.
- Setup rows and steps for custom entries, `start` warnings by harness, and the harness column in `relay info`.
- README for custom entries, and this spec.

**PR 2, `feat/model-routing`, stacked on PR 1.** Routing.

- `src/routes.ts` for parsing, validation, matching, picking a route, reasons, and the `route` trace.
- `numstat -z` parsing with old and new paths, counts without lockfiles, and the changed-file list. Stats move to the clone.
- `withWorktree` split into fetch and checkout, the skip path, and route timeouts.
- The route word in mentions, `run --route`, and the `route` command.
- The `skipped` status, `route` on job records, the ROUTE column, the comment line, and `route` in `meta.json`.
- The routes list in setup's save step, the routes section in `relay info`, and `start` warnings for CLIs that any route uses.
- README routing docs.

Neither PR bumps the version; the release stays its own commit. Each branch gets a greploop pass before its PR opens.

## Testing

Unit tests in the existing `bun:test` style:

- Config: entries, defaults, each error and warning above, and the opt-in guarantee. `config.example.json` must parse to the same reviewers and models as before.
- Routes: each condition, AND across conditions and OR within one, first match, the fallback, the skip rules, mentions and `run` passing over skip routes, skip routes passing over PRs that change agent files, forced routes, and reasons.
- Diff stats: `-z` parsing of renames, deletions, and binary files, counts without lockfiles, and test-file and wide-impact detection on renamed files.
- Mentions: the route word, including a custom mention text with regex characters in it.
- Report, status, and setup: the comment line only with routes, the ROUTE column, skipped rows, and setup keeping custom entries and routes.
- Runner, through `RunnerDeps`: one CLI twice with separate scratch directories and models, `projectFiles` by harness, no worktree on a skip, and route timeouts reaching the harness.

Live checks post nothing. Each uses a temporary config and data directory with `postToPr: false`.

- PR 1: one `run` on an open Agendex PR with a custom Haiku entry.
- PR 2: `route` on Agendex #276 to #279, then one `run` on an open Agendex PR through a route that picks Haiku.

If no Agendex PR is open, I skip the `run` check and say so.

## Decisions

| Topic | Decision |
| - | - |
| Scope | Review stays the only task. Routing picks reviewers per PR. |
| Drivers | Cost and latency, per-repo needs, scrutiny for risky changes |
| Opt-in | No change without `routes` or custom entries |
| Reviewer identity | Custom keys in `models` with `harness` |
| Entry defaults | Self-contained, CLI defaults only |
| Route order | One ordered list, first match wins, `reviewers` as the fallback |
| Conditions | `repos`, `baseBranches`, `sources`, `paths`, `onlyPaths`, line and file counts, `wideImpact` |
| Extras | Skip routes, route timeouts, forcing a route, the `route` command |
| Skip guard | Skip uses only `onlyPaths`, `repos`, `baseBranches`, `sources`, and never skips a PR that changes agent files |
| Mentions and `run` | Never skip |
| Comment | Route and models line, only when `routes` exist |
| Setup | Keeps custom entries and routes, edits neither |
| Counts | Lockfiles left out |
| Globs | `Bun.Glob`, GitHub Actions style |
| Validation | Errors for new fields, warnings for today's shapes |
| Delivery | Two stacked PRs, unit tests plus runner tests, live checks that post nothing |
