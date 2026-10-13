# Multi-instance sync

Status: proposed. Ships as three stacked PRs, `fix/forwarder-stop`, then `feat/sync-claims`, then `feat/sync-sweep`.

## Why

review-relay runs on one machine. Its "each commit is reviewed once" rule lives in `state.json`, the PR comment is found by the signed-in login, and the daemon receives events through `gh webhook forward`, which GitHub allows for one person per repo at a time. Start a second instance on another machine today and this happens:

- The second daemon's forwarder fails with `Hook already exists on this repository`, exits, and is restarted forever, backing off to 60s and filling the log. It takes over by accident when the first daemon stops.
- A commit that reaches both instances (a mention while the hook hands over, a `run` on each) is reviewed twice and posted twice.
- `status`, `cost`, and the TUI show only the jobs this machine ran. A job running on the other machine is invisible, and a copy of its `state.json` would read as failed here, because liveness is judged by pid and boot time.

Sync lets several instances, on one person's machines or across a team, review the same repos as one panel: each commit reviewed once, by whichever instance is up and has a free slot, with every instance able to see what the others did. It is opt-in. A config without `sync` behaves as it does today, except that a standby forwarder logs once instead of looping.

## Goals

- One review per commit across instances, with no shared server, shared disk, or new credentials.
- Whichever instance is up reviews. A laptop that sleeps hands its repos to the desktop without anyone noticing.
- Work shared by capacity: an instance claims a commit only when it has a free slot.
- `status`, `cost`, and the TUI on any instance show the jobs every instance ran.
- Degrades to today's behavior with one instance.

## Non-goals

- GitHub Enterprise Server. `gh webhook forward` only works on github.com, so review-relay does.
- A hub, a relay over the network, or a shared data dir. Instances talk only through GitHub.
- Required status checks or branch protection on the `review-relay` status. It carries a result; nothing is built on it blocking a merge.
- Syncing local reviews (`review-relay review`). They have no PR and stay on the machine that ran them.
- Sharing reports in full. Scores, findings, and usage travel in the PR comment; raw reviewer output stays local.
- Enforcing the same config on every instance. See Instances.
- Changes to the MCP server beyond what `status` gains.
- Per-repo `sync` toggles. The setting is global; a repo can be left out of an instance's `repos` instead.

## How GitHub behaves

Verified on 2026-10-12 against a scratch repo with `gh` 2.102.0 and `gh-webhook` v0.2.0. The design leans on each of these.

- `gh webhook forward` creates a repo hook named `cli`, inactive, and activates it once its websocket is connected. A second forwarder on the same repo fails at once with HTTP 422 `Hook already exists on this repository`.
- The extension has no delete code. GitHub removes the `cli` hook within about a second of the websocket closing, after `kill -9`, SIGINT to the process group, or review-relay's `stop` alike. So `Hook already exists` means a live forwarder holds the repo, and a crash never leaves a stale hook. A machine that sleeps keeps its socket half-open, so its hook can linger until GitHub's keepalive gives up; that window is covered by the sweep, not by hook deletion.
- The forwarder exits when its websocket drops, and the daemon restarts it. A forwarder held idle for 6.5 minutes saw no drop, so the hook is normally stable, but nothing below depends on which instance holds it.
- Commit statuses created at the same moment are all visible on the next read. Their ids are monotonic in the order the server received them, the list endpoint returns newest first, and the combined status endpoint shows the newest status per context.
- Statuses need only the `repo` scope that `gh auth login` grants. Check runs would need a GitHub App.

## Config

```json
"sync": true,
"instance": "laptop",
"sweepMs": 60000
```

| Field | Default | Meaning |
| - | - | - |
| `sync` | `false` | Claims commits through GitHub before reviewing, sweeps for unclaimed commits, and shows other instances' jobs. |
| `instance` | the hostname, lowercased, with runs of other characters as `-` | This instance's name in statuses, the PR comment's meta block, `status`, and logs. Same rules as reviewer ids: `^[a-z0-9][a-z0-9-]{0,31}$`. |
| `sweepMs` | `60000` | How often each repo is swept for unclaimed commits. At least `15000`. |

`instance` and `sweepMs` are read only when `sync` is on; setting them without it warns. The hostname default means the name shows on the PR, so people who don't want a machine name there set `instance`.

### Instances

Instances share nothing but GitHub. Each has its own config, clone, data dir, reviewers, and `gh` login. They may differ: one machine can run Claude and another Codex, and a repo can be in one instance's config only. Whatever instance claims a commit decides its route and reviewers from its own config, and the claim and the comment say which instance that was.

Drift is shown, not refused. `status` and the TUI list the instance per job, and the daemon logs `claimed by desktop` when it loses a commit. A later change can add a config fingerprint to the claim and warn when instances disagree.

Several people on one repo each run their own instance under their own login. The comment lookup then matches the marker regardless of login, so the PR keeps one comment, which a collaborator with write access can edit. The comment's author stays whoever posted first.

## Claims

A claim is a commit status on the PR's head commit, context `review-relay`. It is the cross-instance record of a commit: who is reviewing it, and later what came of it.

| State | Description | When |
| - | - | - |
| `pending` | `laptop · reviewing · claude, codex · 2026-10-13T14:02:11Z` | Claimed and running. The timestamp is the heartbeat. |
| `success` | `laptop · 4/5 · claude 4, codex 5` | Posted. `target_url` is the comment. |
| `success` | `laptop · skipped · route docs` | A skip route matched. |
| `error` | `laptop · failed · all reviewers failed` | The review failed. Retried only by an event, a mention, or `run`, as a failed job is today. |
| `error` | `laptop · superseded · now at 1a2b3c4d` | The PR moved on before the comment was posted. |
| `error` | `laptop · interrupted` | The daemon stopped with the review running, so another instance may take the commit at once. |

Descriptions are at most 140 characters and are parsed by splitting on ` · `: instance, state word, detail, and for a pending claim the heartbeat. Reviewer lists are cut to fit. They never carry findings, file names, or paths.

### Claiming a commit

1. A commit reaches the scheduler as today: a bot start, a PR event, a mention, `run`, or the sweep. The local checks run first, unchanged: trigger mode, drafts, `authors`, the grace period, and the local `state.json`, which stays a cheap first filter for commits this instance handled.
2. The job waits for a free slot, as today. Only then does it claim, so an instance never holds commits it can't start. While it waits it is `queued` locally, as today.
3. Read the combined status for the commit. A `review-relay` status that is `success`, or `error` without a forcing request, means handled: the job is recorded as `claimed` with that instance, and nothing runs. A `pending` claim whose heartbeat is newer than `timeoutMs` plus ten minutes means another instance is on it: same record. An older `pending` is stale and counts as unclaimed.
4. Post `pending` with this instance, the reviewers the route picked, and the time.
5. List the commit's `review-relay` statuses. Among the `pending` ones that aren't stale, the lowest id wins. If another instance's claim is lower, record the job as `claimed` with that instance and release the slot. If this instance won but its status isn't the newest, post the same `pending` again, so the combined status, which shows the newest, names the winner.
6. Review as today: fetch, diff stats, route, worktree, reviewers, report, post. The PR-head check before posting stays. Every five minutes a running review posts its `pending` again with a fresh heartbeat.
7. Post the final status. For a posted review, `target_url` is the comment's URL, so the status in the PR's checks list opens the review.

A mention or `run` is a forcing request. It claims a commit that is `success` or `error`, like a re-review today, but not one with a live `pending` claim: it logs `already being reviewed on desktop` and stops, as a `run` on a commit the daemon is reviewing stops today.

Steps 3 to 5 cost three calls per commit, four with the re-post. The window between two instances' reads in step 3 is closed by step 5: both post, both list, both see both, and the lower id wins on each side.

### Shutdown

On SIGINT or SIGTERM the daemon posts `error · interrupted` for each claim it holds before it exits, one call per running review, so the sweep elsewhere can take those commits without waiting out the heartbeat. A crash leaves the claims `pending` until they go stale.

## The sweep

Events reach one instance per repo. The sweep is how the others find work, and how any instance catches up after a hook handoff or a sleep.

Every `sweepMs`, for each repo in its config, an instance lists the open PRs updated since its last sweep, newest first, with one request, and reads the combined status of each head it hasn't seen. The first sweep after start takes PRs updated since the instance started, so turning sync on doesn't review every open PR. A head with no `review-relay` status is a candidate. Candidates go through the trigger rules the event path applies, read from the head rather than from an event:

| Trigger | The sweep claims a head when |
| - | - |
| `github` | `onPush` is on; or the PR has no `review-relay` comment yet, read from the comment lookup, so the first head of a PR is reviewed and later pushes are not, as today. |
| `greptile` | A Greptile check run exists on the head, from the check-runs list, one call. |
| `coderabbit` | A CodeRabbit status is on the head. It is in the combined status already read. |
| `auto` | Either bot's start is on the head, or the PR's `updatedAt` is at least `graceMs` ago, which is the fallback the event path runs after the grace period. |

Drafts and excluded authors are skipped from the same listing. A head the sweep claims gets source `sweep` and the reason `found by sweep`, and routes can match it with `sources: ["sweep"]`. A commit the sweep finds already claimed is recorded as `claimed` with its instance, which is how remote jobs enter `status`.

A forwarder that gains a repo's hook, at start or after standing by, sweeps that repo at once.

### Budget

A user token has 5,000 requests an hour. The sweep is one request per repo per interval, plus one per head that changed. A claim is three or four, a finish one, a heartbeat one per five minutes of review. Requests that return 304 don't count, so the idle sweep sends `If-None-Match` and costs nothing when nothing changed.

| Setup | Requests an hour | Share |
| - | - | - |
| 5 repos, 60s sweep, 20 new heads | about 400 | 8% |
| 10 repos, 30s sweep, 50 new heads | about 1,500 | 30% |

## Standby forwarders

Today a forwarder that exits is restarted with a backoff from 1s to 60s, and its exit reason is only in the `gh` lines it logged. With or without `sync`:

- A forwarder whose `gh` output says `Hook already exists` is standing by. The daemon logs `[owner/name] another forwarder holds this repo; standing by` once, retries every 30s without further logging, and logs `forwarding` when it gets the hook. `status` shows the forwarder as `standby`.
- `Forwarder.stop` stays as it is: SIGINT to the process group ends `gh` and its extension child at once, and GitHub deletes the hook within a second of the socket closing, which the retest on 2026-10-13 confirmed for review-relay's own `stop`. The README, the site docs, and the code comment that say the extension deletes its webhook are corrected: the forwarder backend deletes it when the socket closes, however the process ends. Signalling only the `gh` wrapper leaves the extension child and the hook alive, which is why the group matters. `stop`'s warning about leftover webhooks after a forced kill goes.

The second point is a fix on its own, and lands first.

## Output

### Jobs and `status`

A `JobRecord` gains `instance`, the name of the instance that ran or claimed it, and a status `claimed`: another instance has the commit. `claimed` counts as handled, like `done` and `skipped`, and never as active.

`status` and the TUI gain an INSTANCE column after SOURCE, hidden when every job shown is this instance's, like ROUTE. A `claimed` row shows the other instance, and its SCORE, reviewers, and COST fill in from the comment once that instance posts, through the sync below.

### Remote jobs

The daemon's sweep already reads every synced repo's recent heads and their statuses. It writes what it learns to `<dataDir>/remote.json`: per head, the instance, the state, the score and reviewer scores parsed from the description, the comment URL, and the times. `status`, `cost`, the TUI, and the MCP `list_reviews` merge these with `state.json`: a local record wins for its own key, a remote record fills `claimed` ones and adds the rest. The TUI refreshes from the file as it does from `state.json`.

Without a daemon running, `review-relay sync` does one sweep's worth of reads and writes `remote.json`, so `status` on a machine with no daemon still shows the other instances' jobs. `status --sync` runs it first.

### The comment's meta block

When `sync` is on, the comment carries a hidden block right after the marker, so it survives truncation:

```
<!-- review-relay:meta {"v":1,"instance":"laptop","sha":"1a2b3c4d…","route":"risky","reviewers":[{"name":"claude","harness":"claude","model":"claude-opus-5-5","effort":"max","ok":true,"score":4,"durationMs":512000,"usage":{"input":120000,"cachedInput":80000,"output":9000,"costUsd":3.21}}]} -->
```

It holds what `meta.json` holds minus the job fields the status already carries. `cost` on another instance reads it through the status's `target_url`, one request per remote job, cached in `remote.json`. The block is about a kilobyte. Without `sync` the comment is as it is today.

Usage and cost are then visible to anyone who can read the PR. On a public repo that is public. The decision below keeps them in; a `sync` option to leave usage out can follow if someone needs it.

### Logs

```
[owner/name] PR #12 @ 1a2b3c4d: claimed, reviewing (opened)
[owner/name] PR #12 @ 1a2b3c4d: claimed by desktop
[owner/name] sweep: 3 PRs updated, 1 unclaimed head, claimed #14 @ 9f8e7d6c
[owner/name] another forwarder holds this repo; standing by
```

## Commands

```sh
review-relay sync                     # read every synced repo's recent heads and statuses into remote.json
review-relay status --sync            # sync, then status
review-relay status                   # INSTANCE column when other instances' jobs are shown
```

`info` shows `sync`, the instance name, and `sweepMs`. `setup` doesn't edit them.

## Validation

- `sync` must be a boolean. `instance` must match the id rules. `sweepMs` must be an integer of at least 15,000.
- `instance` or `sweepMs` without `sync` warns and is ignored.
- A hostname that yields an empty name, after lowercasing and replacing, falls back to `instance-<4 hex>` from a hash of the hostname, with a warning suggesting `instance`.

## How a review runs

1. The scheduler gets a job from an event, a mention, `run`, or the sweep. Local checks as today.
2. The job waits for a slot. With `sync`, it then claims the commit; a lost claim records `claimed` and ends here.
3. Fetch, diff stats, route. A skip posts `success · skipped`.
4. Worktree, lockdown, reviewers, with a heartbeat every five minutes.
5. Report, then post the comment if the commit is still the head, with the meta block.
6. Post the final status with the comment's URL.

Steps 2 and 6 are new; the rest is today's sequence with one status call added at each end.

## Docs

- README: a Sync section covering the config, how claims and the sweep work, what the `review-relay` status shows, standby forwarders, the INSTANCE column, `sync` and `status --sync`, the meta block, and the budget. Limits gains the github.com-only note and the sleeping-laptop window. The daemon control section drops the claim that the extension deletes its webhook.
- `config.example.json` stays without `sync`, since the installers seed configs from it.
- PRODUCT.md gains the capability in its own PR after the release, as routing did.

## Delivery

**PR 1, `fix/forwarder-stop`.** No feature flag.

- The forwarder's comment, the README, and the site docs corrected on who deletes the webhook. `stop`'s leftover-webhooks warning removed.
- Standby handling: the `Hook already exists` line recognized, one log line, a fixed 30s retry, `standby` in `status`.
- Tests for the forwarder's exit handling with a fake `gh`.

**PR 2, `feat/sync-claims`, stacked on PR 1.** Claims, without the sweep.

- `sync`, `instance`, `sweepMs` parsing and validation.
- `src/claims.ts`: status descriptions, parsing, the claim protocol, heartbeats, final statuses, behind a `ClaimDeps` seam in the style of `SchedulerDeps`.
- The scheduler claims after the slot, records `claimed`, and posts `interrupted` on shutdown.
- `upsertComment` returns the comment's id and URL; the meta block; the marker-only lookup.
- `instance` on records, the INSTANCE column.
- Two instances on one repo then work by hand: whichever gets the event claims, and a `run` on the other is told who has it.

**PR 3, `feat/sync-sweep`, stacked on PR 2.** The sweep and remote jobs.

- The sweep per repo and trigger mode, with conditional requests, the catch-up sweep on gaining a hook, source `sweep`.
- `remote.json`, the merge into `status`, `cost`, the TUI, and `list_reviews`, the `sync` command, `status --sync`.
- README Sync section.

Neither PR bumps the version. Each branch gets a greploop pass before its PR opens.

## Testing

Unit tests in the existing `bun:test` style:

- Config: each field, defaults, the hostname fallback, each error and warning, and the opt-in guarantee: a config without `sync` parses to the same `Config` as before, apart from the three new fields.
- Claims, through `ClaimDeps` with an in-memory status list: description rendering under 140 characters, parsing, a clean claim, a lost claim by id, a won claim that re-posts, stale and fresh `pending`, forcing over `success` and `error` but not over a live `pending`, heartbeats, each final state, and `interrupted` on shutdown.
- Scheduler: claim after the slot, the `claimed` record, the slot released on a lost claim, today's dedupe untouched without `sync`.
- Sweep: each trigger mode's rule, the first-sweep watermark, drafts and authors, the 304 path, `remote.json` contents, the catch-up on gaining a hook.
- Forwarder: standby on `Hook already exists`, the single log line, the 30s retry, `stop` timing.
- Report and status: the meta block's placement and size, the comment without `sync` unchanged, the INSTANCE column shown and hidden, remote rows merged.

Live checks on a scratch repo, two processes with different `instance` names and `postToPr: false` except where posting is the thing checked:

- PR 1: two daemons on one repo, the second standing by, the hook handed over on `stop` and on `kill -9`.
- PR 2: both instances `run` the same PR at once; one reviews, the other reports who has it; the status and comment show the winner.
- PR 3: a push with only the standby instance's daemon able to review (the other's `maxConcurrent` busy), picked up by the sweep; `status --sync` on a third machine or data dir showing both.

## Decisions

| Topic | Decision |
| - | - |
| Shared medium | GitHub only: commit statuses for claims and results, the PR comment for the report |
| Claim | `review-relay` status on the head; lowest pending id wins; winner re-posts so the combined status names it |
| Who receives events | Whoever holds the `cli` hook; others stand by and sweep. No leader election |
| Work sharing | Claim only with a free slot; unclaimed heads go to the next sweep anywhere |
| Stale claims | Heartbeat every five minutes; stale after `timeoutMs` plus ten minutes; `interrupted` on shutdown |
| Failed reviews | `error`, retried by events, mentions, and `run`, not by the sweep |
| Trigger rules in the sweep | Read from the head: bot check run or status, grace by `updatedAt`, first head by the comment lookup |
| Remote visibility | `remote.json` written by the sweep or `review-relay sync`; merged into `status`, `cost`, the TUI, `list_reviews` |
| Report sharing | Meta block in the comment, usage included; raw output local |
| Config drift | Allowed and shown, not refused |
| Comment ownership | Marker-only lookup so a PR keeps one comment across logins |
| Instance name | Hostname by default, settable |
| Opt-in | No statuses, sweeps, or meta block without `sync`; standby logging and the stop fix for everyone |
| Delivery | Three stacked PRs, the forwarder fix first |
