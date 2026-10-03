#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { defaultConfigPath, findRepo, loadConfig, type Config } from './config.ts';
import { Forwarder } from './forwarder.ts';
import { resolveJob } from './github.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import { runReview } from './runner.ts';
import { Scheduler, type SchedulerDeps } from './scheduler.ts';
import { routeEvent, startServer } from './server.ts';
import { setup } from './setup.ts';
import { StateStore } from './state.ts';
import { renderStatus } from './status.ts';

const USAGE = `review-relay <command> [options]

Commands:
  start                         Watch configured repos and review PRs as triggers arrive
  run --repo owner/name --pr N  Review one PR now (ignores dedupe)
  replay <events.jsonl>         Feed recorded webhook deliveries through the trigger logic
      --dry-run                 Log what would run instead of running reviewers
      --grace <ms>              Override graceMs for the replay
  status                        Show recent review jobs with scores, timings, and finding counts
      --limit <n>               Number of jobs to show (default 20)
  config                        Print the resolved config (defaults applied) as JSON
  setup                         Pick the repos to watch, the reviewers, and their models in a terminal UI; saves the config

Options:
  --config <path>               Config file (default ~/.review-relay/config.json or $REVIEW_RELAY_CONFIG)
  --version                     Print the version`;

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

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

async function start(config: Config) {
  const state = new StateStore(join(config.dataDir, 'state.json'));
  const scheduler = makeScheduler(config, state);
  const secret = randomBytes(24).toString('hex');
  const server = startServer(config, scheduler, secret);
  log(`listening on http://127.0.0.1:${server.port}/hook (reviewers: ${config.reviewers.join(', ')})`);
  for (const name of config.reviewers) {
    if (!findBin(name)) log(`warning: ${HARNESSES[name].bins.join(' or ')} not on PATH, so ${name} reviews will fail`);
  }

  const forwarders = config.repos.map(
    (repo) => new Forwarder(repo, `http://127.0.0.1:${server.port}/hook`, secret, log),
  );
  for (const f of forwarders) f.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping forwarders (removes temporary repo webhooks)...');
    await Promise.all(forwarders.map((f) => f.stop()));
    server.stop(true);
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, shutdown);
  // Forwarders run in their own process groups, so they outlive a daemon that exits without cleanup.
  process.on('exit', () => {
    for (const f of forwarders) f.stopSync();
  });
}

async function runOnce(config: Config, repoName: string | undefined, pr: string | undefined) {
  const repo = findRepo(config, repoName);
  if (!repo || !pr) throw new Error('run needs --repo <configured owner/name> and --pr <number>');
  const state = new StateStore(join(config.dataDir, 'state.json'));
  const scheduler = makeScheduler(config, state);
  scheduler.runNow(repo, { repo: repo.fullName, pr: Number(pr), source: 'manual', reason: 'manual run' });
  await scheduler.idle();
}

async function replay(config: Config, file: string | undefined, dryRun: boolean, grace: string | undefined) {
  if (!file) throw new Error('replay needs a JSONL file of {"event", "payload"} lines');
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
  const lines = (await Bun.file(file).text()).split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const entry = JSON.parse(line) as { event: string; payload?: unknown; body?: unknown };
    routeEvent(config, scheduler, entry.event, entry.payload ?? entry.body, log);
  }
  await scheduler.idle();
}

function status(config: Config, limit: string | undefined) {
  const records = new StateStore(join(config.dataDir, 'state.json')).list().slice(0, Number(limit ?? 20));
  const lines = renderStatus(records, {
    dataDir: config.dataDir,
    reviewers: config.reviewers,
    color: Boolean(process.stdout.isTTY),
  });
  for (const line of lines) console.log(`  ${line}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      grace: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [command, arg] = positionals;
  if (values.version) return console.log(version);
  if (!command || values.help) return console.log(USAGE);
  // setup writes the config, so it must not require a valid one first.
  if (command === 'setup') return setup(values.config ?? defaultConfigPath());

  const config = await loadConfig(values.config);
  switch (command) {
    case 'start':
      return start(config);
    case 'run':
      return runOnce(config, values.repo, values.pr);
    case 'replay':
      return replay(config, arg, values['dry-run'], values.grace);
    case 'status':
      return status(config, values.limit);
    case 'config':
      return console.log(JSON.stringify(config, null, 2));
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
