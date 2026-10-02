#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findRepo, loadConfig, type Config } from './config.ts';
import { Forwarder } from './forwarder.ts';
import { resolveJob } from './github.ts';
import { runReview } from './runner.ts';
import { Scheduler, type SchedulerDeps } from './scheduler.ts';
import { routeEvent, startServer } from './server.ts';
import { StateStore } from './state.ts';

const USAGE = `review-relay <command> [options]

Commands:
  start                         Watch configured repos and review PRs as triggers arrive
  run --repo owner/name --pr N  Review one PR now (ignores dedupe)
  replay <events.jsonl>         Feed recorded webhook deliveries through the trigger logic
      --dry-run                 Log what would run instead of running reviewers
      --grace <ms>              Override graceMs for the replay
  status                        Show recent review jobs

Options:
  --config <path>               Config file (default ~/.review-relay/config.json or $REVIEW_RELAY_CONFIG)`;

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
  const scheduler = makeScheduler(config, state, dryRun
    ? {
        resolve: async (job) => ({ ...job, headSha: job.headSha ?? 'unresolved', baseRef: job.baseRef ?? 'unresolved' }),
        run: async (job) => {
          log(`[dry-run] would review ${job.repo} PR #${job.pr} @ ${job.headSha.slice(0, 8)} (source=${job.source})`);
          return {};
        },
      }
    : {});
  const lines = (await Bun.file(file).text()).split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const entry = JSON.parse(line) as { event: string; payload?: unknown; body?: unknown };
    routeEvent(config, scheduler, entry.event, entry.payload ?? entry.body, log);
  }
  await scheduler.idle();
}

function status(config: Config) {
  const records = new StateStore(join(config.dataDir, 'state.json')).list().slice(0, 20);
  if (records.length === 0) return console.log('no review jobs yet');
  for (const r of records) {
    console.log(`${r.startedAt}  ${r.status.padEnd(7)} ${r.repo} #${r.pr} @ ${r.headSha.slice(0, 8)} (${r.source})${r.error ? `  ${r.error}` : ''}`);
    if (r.reportDir) console.log(`  ${r.reportDir}`);
  }
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
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;
  if (!command || values.help) return console.log(USAGE);

  const config = await loadConfig(values.config);
  switch (command) {
    case 'start':
      return start(config);
    case 'run':
      return runOnce(config, values.repo, values.pr);
    case 'replay':
      return replay(config, arg, values['dry-run'], values.grace);
    case 'status':
      return status(config);
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
