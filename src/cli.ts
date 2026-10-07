#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { checkLabels, defaultConfigPath, findRepo, loadConfig, type Config } from './config.ts';
import {
  clearDaemonInfo,
  inspectDaemon,
  isOutdated,
  logFilePath,
  readLast,
  readRange,
  spawnDetached,
  stopDaemon,
  waitForStart,
  writeDaemonInfo,
  type DaemonState,
} from './daemon.ts';
import { describeStats, diffStats } from './diffstats.ts';
import { Forwarder } from './forwarder.ts';
import { openPrForCommit, prAuthor, prHead, resolveJob } from './github.ts';
import { renderCommandHelp, renderHelp } from './help.ts';
import { busyLocal, localTag, localTarget, reviewLocal } from './local.ts';
import { renderMarkdown } from './markdown.ts';
import { renderDaemon, renderInfo } from './overview.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import { COMMENT_MARKER, combinedScore } from './report.ts';
import { explainRoutes, pickRoute, SOURCES } from './routes.ts';
import { RUNNER_DEPS, runReview } from './runner.ts';
import { Scheduler, type SchedulerDeps } from './scheduler.ts';
import { routeEvent, startServer } from './server.ts';
import { setup } from './setup.ts';
import { StateStore } from './state.ts';
import { paginate, renderStatus } from './status.ts';
import { tui } from './tui.ts';
import { jobKey, type JobSource } from './types.ts';
import { ANSI, row, sanitize, section, styles, tildify } from './ui.ts';
import { mergeFindings } from './verdict.ts';
import { baseRemoteRef, fetchPr } from './worktree.ts';

const st = styles();
const err = styles(process.stderr.isTTY && st.color);

/** The UTC time of day that starts each log line. */
const logTime = () => new Date().toISOString().slice(11, 19);

/** Appends timestamped lines to daemon.log, for a foreground command whose own output is the terminal. */
const appendLog = (dataDir: string) => (message: string) => {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(logFilePath(dataDir), `${logTime()} ${message}\n`);
};

/** Timestamped log line; the tag `[owner/repo]` and the time are colored on a terminal only. */
const log = (message: string) => {
  const time = logTime();
  const tagged = st.color ? message.replace(/^\[([^\]]+)\]/, (_, tag) => st.paint(ANSI.cyan, `[${tag}]`)) : message;
  console.log(`${st.muted(time)} ${tagged}`);
};

const print = (lines: string[]) => console.log(lines.join('\n'));
const fail = (message: string): never => {
  console.error(`${err.badge('danger', message)}`);
  process.exit(1);
};
const warn = (message: string) => console.log(err.badge('warning', message));
const ok = (message: string) => console.log(st.badge('success', message));

function makeScheduler(config: Config, state: StateStore, overrides: Partial<SchedulerDeps> = {}) {
  return new Scheduler({
    state,
    graceMs: config.graceMs,
    maxConcurrent: config.maxConcurrent,
    resolve: resolveJob,
    findPr: openPrForCommit,
    prHead: (job) => prHead(job.repo, job.pr),
    prAuthor,
    run: (job, repo, signal) => runReview(job, repo, config, RUNNER_DEPS, signal),
    log,
    ...overrides,
  });
}

interface Options {
  config?: string;
  repo?: string;
  pr?: string;
  dryRun: boolean;
  grace?: string;
  limit?: string;
  page?: string;
  route?: string;
  source?: string;
  base?: string;
  head?: string;
  reviewers?: string;
  minScore?: string;
  headName?: string;
  baseName?: string;
  worker: boolean;
  detach: boolean;
  follow: boolean;
  json: boolean;
}

/** The daemon itself: HTTP hook server plus one `gh webhook forward` per repo, until a signal arrives. */
async function serve(config: Config, configPath: string) {
  const existing = await inspectDaemon(config.dataDir, config.port);
  if (existing.running) fail(`already running (pid ${existing.pid}); use review-relay status or stop`);
  if (existing.foreign) fail(`port ${config.port} is already in use by something that is not review-relay`);

  const state = new StateStore(join(config.dataDir, 'state.json'));
  const scheduler = makeScheduler(config, state);
  const secret = randomBytes(24).toString('hex');
  let server: ReturnType<typeof startServer>;
  try {
    server = startServer(config, scheduler, secret);
  } catch (e) {
    return fail(`cannot listen on 127.0.0.1:${config.port}: ${e instanceof Error ? e.message : e}`);
  }
  const startedAt = new Date().toISOString();
  const url = `http://127.0.0.1:${server.port ?? config.port}/hook`;

  print([
    `${st.title('review-relay')}  ${st.muted(`v${version}`)}  ${st.muted(`pid ${process.pid}`)}`,
    row(st, 'endpoint', url),
    row(
      st,
      'reviewers',
      config.reviewers
        .map((n) => {
          const m = config.models[n]!;
          return `${n}${m.model || m.effort ? st.muted(` (${[m.model, m.effort].filter(Boolean).join(' ')})`) : ''}`;
        })
        .join(', '),
    ),
    ...(config.routes.length > 0 ? [row(st, 'routes', config.routes.map((route) => route.name).join(', '))] : []),
    row(st, 'repos', config.repos.map((r) => `${r.fullName} ${st.muted(`(${r.trigger})`)}`).join(', ')),
    row(st, 'config', tildify(configPath)),
    '',
  ]);
  const used = new Set([...config.reviewers, ...config.routes.flatMap((route) => route.reviewers ?? [])]);
  for (const [harness, ids] of Map.groupBy(used, (id) => config.models[id]!.harness)) {
    if (findBin(harness)) continue;
    warn(`${HARNESSES[harness].bins.join(' or ')} not on PATH, so ${ids.join(' and ')} reviews will fail`);
  }

  const forwarders: Forwarder[] = [];
  const record = () =>
    writeDaemonInfo(config.dataDir, {
      pid: process.pid,
      port: server.port ?? config.port,
      startedAt,
      version,
      configPath,
      forwarders: forwarders.map((f) => f.info()),
    });
  for (const repo of config.repos) forwarders.push(new Forwarder(repo, url, secret, log, record));
  record();
  for (const f of forwarders) f.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping forwarders (removes temporary repo webhooks)...');
    await Promise.all(forwarders.map((f) => f.stop()));
    server.stop(true);
    clearDaemonInfo(config.dataDir);
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, shutdown);
  // Forwarders run in their own process groups, so they outlive a daemon that exits without cleanup.
  process.on('exit', () => {
    for (const f of forwarders) f.stopSync();
    clearDaemonInfo(config.dataDir);
  });
}

async function startDetached(config: Config, configPath: string) {
  const existing = await inspectDaemon(config.dataDir, config.port);
  if (existing.running) {
    warn(`already running (pid ${existing.pid})`);
    if (isOutdated(existing, version)) {
      warn(
        `daemon runs ${existing.version ? `v${existing.version}` : 'an older version'}, installed is v${version}; run review-relay restart`,
      );
    }
    return showStatus(config, configPath, existing);
  }
  // Otherwise the health wait below would accept the other listener's reply and report a daemon that never bound.
  if (existing.foreign) fail(`port ${config.port} is already in use by something that is not review-relay`);
  const pid = spawnDetached(config.dataDir, ['start', '--config', configPath]);
  const problem = await waitForStart(config.dataDir, pid, config.port);
  if (problem) {
    const tail = lastLines(logFilePath(config.dataDir), 10);
    fail(`${problem}; last log lines:\n${tail.map((l) => `  ${l}`).join('\n')}`);
  }
  const state = await inspectDaemon(config.dataDir, config.port);
  ok(`started (pid ${state.pid ?? pid})`);
  console.log();
  return showStatus(config, configPath, state);
}

async function stop(config: Config): Promise<boolean> {
  const state = await inspectDaemon(config.dataDir, config.port);
  if (!state.running) {
    if (state.stale) clearDaemonInfo(config.dataDir);
    warn(state.stale ? `not running (removed stale record for pid ${state.pid})` : 'not running');
    return false;
  }
  process.stdout.write(st.muted(`stopping pid ${state.pid}... `));
  const result = await stopDaemon(state, config.dataDir);
  console.log();
  if (result.clean) ok(`stopped (pid ${result.pid})`);
  else {
    warn(`no clean exit after 20s; killed pid ${result.pid}`);
    warn('temporary GitHub webhooks may remain; check each repo under Settings > Webhooks');
  }
  return true;
}

async function showStatus(
  config: Config,
  configPath: string,
  state: DaemonState | undefined,
  limit?: string,
  page?: string,
) {
  const size = positiveInt('--limit', limit, 20);
  const pageNo = positiveInt('--page', page, 1);
  state ??= await inspectDaemon(config.dataDir, config.port);
  const daemon = renderDaemon(state, { version, configPath, logPath: logFilePath(config.dataDir) }, st);
  // Only the requested page is rendered, so reports are read for at most `size` jobs.
  const jobs = paginate(new StateStore(join(config.dataDir, 'state.json')).list(), pageNo, size);
  const table = renderStatus(jobs.items, { dataDir: config.dataDir, reviewers: config.reviewers, color: st.color });
  const heading =
    jobs.pages > 1
      ? [
          '',
          `${st.section('Recent jobs')}  ${st.muted(`${jobs.from}-${jobs.to} of ${jobs.total} • page ${jobs.page}/${jobs.pages}`)}`,
        ]
      : section(st, 'Recent jobs');
  const more =
    jobs.page < jobs.pages
      ? [
          '',
          `  ${st.muted('older:')} ${st.command(`review-relay status --page ${jobs.page + 1}${limit === undefined ? '' : ` --limit ${size}`}`)}`,
        ]
      : [];
  print([...daemon.lines, ...heading, ...table.map((l) => `  ${l}`), ...more]);
  if (daemon.exitCode) process.exitCode = daemon.exitCode;
}

function positiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} takes a positive whole number, got "${value}"`);
  return n;
}

async function info(config: Config, configPath: string, json: boolean) {
  if (json) return console.log(JSON.stringify(config, null, 2));
  const daemon = await inspectDaemon(config.dataDir, config.port);
  let configMtimeMs: number | null = null;
  try {
    configMtimeMs = statSync(configPath).mtimeMs;
  } catch {
    // Config came from somewhere we cannot stat; skip the freshness note.
  }
  const bins = Object.fromEntries(config.reviewers.map((n) => [n, findBin(config.models[n]!.harness)]));
  print(
    renderInfo(config, { version, configPath, logPath: logFilePath(config.dataDir), bins, configMtimeMs, daemon }, st),
  );
}

function lastLines(path: string, n: number): string[] {
  try {
    return readLast(path, n).map(sanitize);
  } catch {
    return [];
  }
}

async function logs(config: Config, count: string | undefined, follow: boolean) {
  const path = logFilePath(config.dataDir);
  const n = Number(count ?? 50);
  if (!Number.isFinite(n) || n < 0) fail(`logs takes a line count, got "${count}"`);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    warn(`no log yet at ${tildify(path)}; start the daemon with review-relay start -d`);
    return;
  }
  for (const line of lastLines(path, n)) console.log(line);
  if (!follow) return;
  console.log(st.muted(`── following ${tildify(path)} (ctrl-c to stop) ──`));
  for (;;) {
    await Bun.sleep(300);
    let now: number;
    try {
      now = statSync(path).size;
    } catch {
      continue;
    }
    if (now < size) size = 0; // truncated or rotated
    if (now === size) continue;
    const text = readRange(path, size, now);
    size = now;
    process.stdout.write(sanitize(text));
  }
}

/** Names the configured repos next to the one that wasn't found, since a typo in `owner/name` is the usual cause. */
const unknownRepo = (config: Config, name: string) =>
  `no configured repo named "${name}" (configured: ${config.repos.map((r) => r.fullName).join(', ') || 'none'})`;

/** Fails unless `route` names a route that reviews, so a typo never falls through to normal routing. */
function checkRoute(config: Config, route: string, command: string) {
  const named = config.routes.find((r) => r.name === route);
  const names = config.routes.map((r) => r.name).join(', ') || 'none configured';
  if (!named) fail(`no route named "${route}" (routes: ${names})`);
  if (named!.skip) fail(`route "${route}" skips the review, so ${command} can't use it`);
}

async function runOnce(config: Config, repoName: string | undefined, pr: string | undefined, route?: string) {
  const repo = findRepo(config, repoName);
  if (!repoName || !pr) fail('run needs --repo <configured owner/name> and --pr <number>');
  if (!repo) fail(unknownRepo(config, repoName!));
  if (route !== undefined) checkRoute(config, route, 'run');
  const state = new StateStore(join(config.dataDir, 'state.json'));
  const scheduler = makeScheduler(config, state);
  scheduler.runNow(repo!, {
    repo: repo!.fullName,
    pr: Number(pr),
    source: 'manual',
    reason: 'manual run',
    ...(route ? { route } : {}),
  });
  await scheduler.idle();
}

/** The config a `review --reviewers` list runs with: those reviewers, and no routes to override them. */
function withReviewers(config: Config, list: string): Config {
  const ids = [...new Set(list.split(',').map((id) => id.trim()))].filter(Boolean);
  if (ids.length === 0) fail('--reviewers takes reviewer ids separated by commas, such as codex,claude');
  const unknown = ids.filter((id) => !config.models[id]);
  if (unknown.length > 0) {
    fail(`no reviewer named ${unknown.join(', ')} (reviewers: ${Object.keys(config.models).join(', ')})`);
  }
  checkLabels(ids, config.models);
  return { ...config, reviewers: ids, routes: [] };
}

/**
 * Aborts on ctrl-c or SIGTERM, so the reviewers stop and the worktree is removed; a second ctrl-c quits at once.
 * `release` removes the handlers.
 */
function stopOnSignal(onStop: () => void) {
  const controller = new AbortController();
  const handle = () => {
    if (controller.signal.aborted) process.exit(130);
    onStop();
    controller.abort('interrupted');
  };
  const signals = ['SIGINT', 'SIGTERM'] as const;
  for (const sig of signals) process.on(sig, handle);
  return { signal: controller.signal, release: () => signals.forEach((sig) => process.off(sig, handle)) };
}

/**
 * Reviews the current branch against a base in this checkout, before any PR exists: the same reviewers, rubric, and
 * score as a PR review. In the foreground it prints the review and exits 1 under `--min-score`; with -d a background
 * worker runs it. Either way the job is recorded, so `status` and the TUI list it.
 */
async function reviewBranch(config: Config, configPath: string, opts: Options) {
  const minScore = opts.minScore === undefined ? undefined : positiveInt('--min-score', opts.minScore, 1);
  if (minScore !== undefined && minScore > 5) fail(`--min-score takes 1 to 5, got ${minScore}`);
  if (opts.detach && (opts.json || minScore !== undefined)) {
    fail('--json and --min-score report in the foreground; drop -d to use them');
  }
  if (opts.route !== undefined && opts.reviewers !== undefined) fail('pass --route or --reviewers, not both');
  if (opts.route !== undefined) checkRoute(config, opts.route, 'review');
  const reviewConfig = opts.reviewers === undefined ? config : withReviewers(config, opts.reviewers);

  const target = await localTarget(reviewConfig, process.cwd(), {
    base: opts.base,
    head: opts.head,
    headName: opts.headName,
    baseName: opts.baseName,
    route: opts.route,
  });
  const { job, repo, commits, dirty } = target;
  const state = new StateStore(join(config.dataDir, 'state.json'));

  if (opts.worker) {
    // Spawned by -d or the TUI, with stdout in daemon.log.
    const { signal, release } = stopOnSignal(() => log(`${localTag({ ...job, branch: job.headRef })}: stopping`));
    await reviewLocal(target, reviewConfig, { state, log, signal }).finally(release);
    return;
  }

  // A fast answer for the common case; the review's own claim is what keeps two runs apart.
  if (state.isActive(jobKey(job))) fail(`${busyLocal(job)}; follow it in review-relay tui`);

  const stats = await diffStats(repo.localPath, baseRemoteRef(job), job.headSha);
  const pick = pickRoute(reviewConfig, job, stats);
  const note = (line: string) => console.error(line);
  note(
    `${err.title('review-relay')} ${job.repo} ${err.command(job.headRef!)} ${err.muted(`@ ${job.headSha.slice(0, 8)}`)} against ${job.baseName}`,
  );
  note(row(err, 'change', `${commits} ${commits === 1 ? 'commit' : 'commits'}; ${describeStats(stats)}`));
  note(
    row(
      err,
      'reviewers',
      pick.reviewers.join(', '),
      pick.route ? `route ${pick.route.name} (${pick.route.reason})` : undefined,
    ),
  );
  if (dirty) note(err.badge('warning', 'uncommitted changes are left out; commit them to include them'));

  if (opts.detach) {
    // The worker reviews the SHA resolved here, so a commit made right after this returns isn't picked up.
    const pid = spawnDetached(
      config.dataDir,
      [
        'review',
        '--worker',
        '--config',
        configPath,
        '--base',
        job.base!,
        '--base-name',
        job.baseName!,
        '--head',
        job.headSha,
        '--head-name',
        job.headRef!,
        ...(opts.route ? ['--route', opts.route] : []),
        ...(opts.reviewers ? ['--reviewers', opts.reviewers] : []),
      ],
      repo.localPath,
    );
    note(err.badge('success', `reviewing in the background (pid ${pid})`));
    note(
      `  ${err.muted('follow it with')} ${err.command('review-relay tui')} ${err.muted('or')} ${err.command('review-relay logs -f')}`,
    );
    return;
  }

  note(err.muted(`reviewing; this can take several minutes (ctrl-c stops)`));
  const { signal, release } = stopOnSignal(() =>
    note(err.muted('stopping reviewers... (ctrl-c again to quit at once)')),
  );
  // Logged to daemon.log as well, so the TUI's log view shows this job like any other.
  const outcome = await reviewLocal(target, reviewConfig, { state, log: appendLog(config.dataDir), signal }).finally(
    release,
  );
  if (signal.aborted) {
    note(err.badge('warning', 'interrupted; no report written'));
    process.exit(130);
  }

  const results = outcome.results ?? [];
  const confidence = combinedScore(results);
  if (opts.json) {
    const passed = results.filter((r) => r.ok && r.verdict);
    console.log(
      JSON.stringify(
        {
          repo: job.repo,
          branch: job.headRef,
          headSha: job.headSha,
          base: job.baseName,
          baseSha: job.base,
          commits,
          score: confidence,
          route: outcome.route ?? null,
          reportDir: outcome.reportDir,
          // The raw output and verdicts stay in the report files; findings below merge the verdicts.
          reviewers: results.map(({ output: _output, verdict: _verdict, ...reviewer }) => reviewer),
          findings: mergeFindings(passed.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings }))),
        },
        null,
        2,
      ),
    );
  } else {
    const width = Math.min(process.stdout.columns || 100, 120);
    console.log();
    // The marker only finds the comment on GitHub.
    // Reviewer-written, so escapes are stripped as the TUI strips them.
    print(renderMarkdown(sanitize((outcome.comment ?? '').replace(`${COMMENT_MARKER}\n`, '')), width, st));
    console.log();
    console.log(row(st, 'report', tildify(outcome.reportDir ?? '')));
  }
  if (minScore !== undefined && (confidence === null || confidence < minScore)) {
    note(err.badge('danger', `confidence ${confidence ?? '?'}/5 is under --min-score ${minScore}`));
    process.exitCode = 1;
  }
}

/** Fetches the PR and prints how every route judges it, without running a reviewer or touching job state. */
async function explain(config: Config, repoName: string | undefined, pr: string | undefined, source = 'github') {
  const repo = findRepo(config, repoName);
  if (!repoName || !pr) return fail('route needs --repo <configured owner/name> and --pr <number>');
  if (!repo) return fail(unknownRepo(config, repoName!));
  if (!SOURCES.includes(source as JobSource)) return fail(`--source must be one of ${SOURCES.join(', ')}`);
  const job = await resolveJob(
    { repo: repo.fullName, pr: Number(pr), source: source as JobSource, reason: 'route' },
    { open: false },
  );
  await fetchPr(repo, job);
  const stats = await diffStats(repo.localPath, baseRemoteRef(job), job.headSha);
  print(explainRoutes(config, job, stats));
}

async function replay(config: Config, file: string | undefined, dryRun: boolean, grace: string | undefined) {
  if (!file) fail('replay needs a JSONL file of {"event", "payload"} lines');
  if (grace !== undefined) config.graceMs = Number(grace);
  const state = new StateStore(dryRun ? null : join(config.dataDir, 'state.json'));
  const scheduler = makeScheduler(
    config,
    state,
    dryRun
      ? {
          resolve: async (job) => ({
            ...job,
            headSha: job.headSha ?? 'unresolved',
            baseRef: job.baseRef ?? 'unresolved',
          }),
          // Offline: a commit status names no PR, so the PR stays unknown (#0).
          findPr: async (repo, sha) => {
            log(`[dry-run] would look up the open PR in ${repo} whose head is ${sha.slice(0, 8)}`);
            return { pr: 0, headRef: 'unresolved', baseRef: 'unresolved' };
          },
          // Offline: every replayed commit counts as its PR's head.
          prHead: async (job) => job.headSha,
          // Offline: an author the event didn't name stays unknown, so a repo with `authors` ignores it.
          prAuthor: async (repo, pr) => {
            log(`[dry-run] would look up the author of ${repo} PR #${pr}`);
            return 'unresolved';
          },
          run: async (job) => {
            log(`[dry-run] would review ${job.repo} PR #${job.pr} @ ${job.headSha.slice(0, 8)} (source=${job.source})`);
            return {};
          },
        }
      : {},
  );
  const lines = (await Bun.file(file!).text()).split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const entry = JSON.parse(line) as { event: string; payload?: unknown; body?: unknown };
    routeEvent(config, scheduler, entry.event, entry.payload ?? entry.body, log);
  }
  await scheduler.idle();
}

export function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      grace: { type: 'string' },
      limit: { type: 'string' },
      page: { type: 'string' },
      route: { type: 'string' },
      source: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      reviewers: { type: 'string' },
      'min-score': { type: 'string' },
      // Internal: how -d and the TUI start a background review.
      'head-name': { type: 'string' },
      'base-name': { type: 'string' },
      worker: { type: 'boolean', default: false },
      detach: { type: 'boolean', short: 'd', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const opts: Options = {
    config: values.config,
    repo: values.repo,
    pr: values.pr,
    dryRun: values['dry-run'],
    grace: values.grace,
    limit: values.limit,
    page: values.page,
    route: values.route,
    source: values.source,
    base: values.base,
    head: values.head,
    reviewers: values.reviewers,
    minScore: values['min-score'],
    headName: values['head-name'],
    baseName: values['base-name'],
    worker: values.worker,
    detach: values.detach,
    follow: values.follow,
    json: values.json,
  };
  return { opts, positionals, help: values.help, version: values.version };
}

const COMMANDS = [
  'start',
  'stop',
  'restart',
  'status',
  'tui',
  'logs',
  'run',
  'review',
  'route',
  'replay',
  'setup',
  'info',
  'config',
  'help',
];

async function main() {
  const { opts, positionals, help, version: showVersion } = parse(process.argv.slice(2));
  const [command, arg] = positionals;
  if (showVersion) return console.log(version);
  // `help <cmd>` and `<cmd> --help` both open the command's page; bare help opens the overview.
  const helpFor = command === 'help' ? arg : help ? command : undefined;
  if (!command || (command === 'help' && !arg) || (help && !helpFor)) return console.log(renderHelp(version, st));
  if (helpFor === 'help') return console.log(renderHelp(version, st));
  if (helpFor) {
    const page = renderCommandHelp(helpFor, version, st);
    if (page) return console.log(page);
    console.error(`${err.badge('danger', `unknown command "${helpFor}"`)}\n`);
    console.error(renderHelp(version, err));
    process.exit(1);
  }
  if (!COMMANDS.includes(command)) {
    console.error(`${err.badge('danger', `unknown command "${command}"`)}\n`);
    console.error(renderHelp(version, err));
    process.exit(1);
  }
  // Absolute, since background reviews run in the checkout, not where this was started.
  const configPath = resolve(opts.config ?? defaultConfigPath());
  // setup writes the config, so it must not require a valid one first.
  if (command === 'setup') return setup(configPath);

  // On stderr, so `config` and `info --json` output stays plain JSON.
  const config = await loadConfig(configPath, (message) => console.error(`warning: ${message}`));
  switch (command) {
    case 'start':
      return opts.detach ? startDetached(config, configPath) : serve(config, configPath);
    case 'stop':
      return stop(config);
    case 'restart':
      await stop(config);
      return startDetached(config, configPath);
    case 'status':
      return showStatus(config, configPath, undefined, opts.limit, opts.page);
    case 'tui':
      return tui(config, configPath, version);
    case 'logs':
      return logs(config, arg, opts.follow);
    case 'run':
      return runOnce(config, opts.repo, opts.pr, opts.route);
    case 'review':
      return reviewBranch(config, configPath, opts);
    case 'route':
      return explain(config, opts.repo, opts.pr, opts.source);
    case 'replay':
      return replay(config, arg, opts.dryRun, opts.grace);
    case 'info':
      return info(config, configPath, opts.json);
    case 'config':
      return info(config, configPath, true);
  }
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
