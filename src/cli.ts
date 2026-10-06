#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { defaultConfigPath, findRepo, loadConfig, type Config } from './config.ts';
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
import { diffStats } from './diffstats.ts';
import { Forwarder } from './forwarder.ts';
import { resolveJob } from './github.ts';
import { renderCommandHelp, renderHelp } from './help.ts';
import { renderDaemon, renderInfo } from './overview.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import { explainRoutes, SOURCES } from './routes.ts';
import { runReview } from './runner.ts';
import { Scheduler, type SchedulerDeps } from './scheduler.ts';
import { routeEvent, startServer } from './server.ts';
import { setup } from './setup.ts';
import { StateStore } from './state.ts';
import { paginate, renderStatus } from './status.ts';
import { tui } from './tui.ts';
import type { JobSource } from './types.ts';
import { ANSI, row, sanitize, section, styles, tildify } from './ui.ts';
import { baseRemoteRef, fetchPr } from './worktree.ts';

const st = styles();
const err = styles(process.stderr.isTTY && st.color);

/** Timestamped log line; the tag `[owner/repo]` and the time are colored on a terminal only. */
const log = (message: string) => {
  const time = new Date().toISOString().slice(11, 19);
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
    resolve: resolveJob,
    run: (job, repo) => runReview(job, repo, config),
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

async function runOnce(config: Config, repoName: string | undefined, pr: string | undefined, route?: string) {
  const repo = findRepo(config, repoName);
  if (!repo || !pr) fail('run needs --repo <configured owner/name> and --pr <number>');
  if (route !== undefined) {
    const named = config.routes.find((r) => r.name === route);
    const names = config.routes.map((r) => r.name).join(', ') || 'none configured';
    if (!named) return fail(`no route named "${route}" (routes: ${names})`);
    if (named.skip) return fail(`route "${route}" skips the review, so run can't use it`);
  }
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

/** Fetches the PR and prints how every route judges it, without running a reviewer or touching job state. */
async function explain(config: Config, repoName: string | undefined, pr: string | undefined, source = 'github') {
  const repo = findRepo(config, repoName);
  if (!repo || !pr) return fail('route needs --repo <configured owner/name> and --pr <number>');
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
  const configPath = opts.config ?? defaultConfigPath();
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
