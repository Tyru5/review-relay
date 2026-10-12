/**
 * `review-relay mcp`: a Model Context Protocol server on stdin and stdout, so an agent can start a review of the
 * branch it is working on, or of a PR, and read back the score and findings.
 *
 * Reviews take minutes, longer than many MCP clients wait for one tool call, so starting one returns at once with
 * the job's key, and a background process runs it exactly as `review -d` and `run` do. `get_review` reads the result,
 * waiting up to `waitSeconds` for it. Messages are newline-delimited JSON-RPC 2.0; stdout carries nothing else.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkRoute, findRepo, loadConfig, pricesFor, withReviewers, type Config } from './config.ts';
import { commandLine, isAlive, logFilePath, readRange, spawnDetached } from './daemon.ts';
import { diffStats } from './diffstats.ts';
import { prHead } from './github.ts';
import { localTarget } from './local.ts';
import { pickRoute } from './routes.ts';
import { activeJob, StateStore, type JobRecord, type JobStatus } from './state.ts';
import { readReport } from './status.ts';
import { isLocal, jobKey } from './types.ts';
import { sanitize } from './ui.ts';
import { mergeFindings, type Finding } from './verdict.ts';
import { baseRemoteRef } from './worktree.ts';

/** Newest first; the first is offered to a client that asks for none of them. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The longest `waitSeconds` takes, so one call can't hold a request open for a whole review timeout. */
export const MAX_WAIT_SECONDS = 600;

/** How long starting a review waits for its background process to record the job before returning `starting`. */
const START_WAIT_MS = 15_000;

/**
 * How often a start's pid is checked against the command line it was started with, since pids get reused. Also how long
 * after the spawn the first check waits, while the child may still be running this process's image before its exec.
 */
const PID_CHECK_MS = 5_000;

/** The statuses a job can have, which `list_reviews` filters by. */
const STATUSES: JobStatus[] = ['queued', 'running', 'done', 'failed', 'skipped', 'superseded'];

/** What the server touches outside itself. Tests stand in for them. */
export interface McpDeps {
  version: string;
  configPath: string;
  /** Where `review_branch` reviews when the call names no path: the directory the client started the server in. */
  cwd: string;
  loadConfig: (path: string) => Promise<Config>;
  /** Starts this CLI in the background with `args`, as `review -d` does; returns the pid. */
  spawn: (dataDir: string, args: string[], cwd?: string) => number;
  prHead: (repo: string, pr: number) => Promise<string>;
  isAlive: (pid: number) => boolean;
  /** A process's command line, or null when it can't be read. */
  commandLine: (pid: number) => string | null;
  /** Warnings and errors, which must stay off stdout. */
  log: (message: string) => void;
  pollMs?: number;
  /** How long a start call waits for the job's record; START_WAIT_MS when unset. */
  startWaitMs?: number;
  /** PID_CHECK_MS when unset. */
  pidCheckMs?: number;
}

export const MCP_DEPS: Omit<McpDeps, 'version' | 'configPath' | 'cwd'> = {
  loadConfig: (path) => loadConfig(path, (message) => console.error(`warning: ${message}`)),
  spawn: spawnDetached,
  prHead,
  isAlive,
  commandLine,
  log: (message) => console.error(message),
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

/** A background process this server started for a job, until the job's record shows up or the process exits. */
interface Start {
  pid: number;
  /** The `--spawn-id` the process was started with: in its command line, and at the end of every line it logs. */
  id: string;
  /** Epoch ms the pid was last confirmed to be this process. */
  checkedAt: number;
  /** Epoch ms of the spawn; a record of the same commit from before it is an earlier review's. */
  since: number;
  repo: string;
  /** The PR, for a PR review; `get_review` by repo and pr finds the start through it. */
  pr?: number;
  /** Where daemon.log ended at the spawn, so a failure reads only what was written since. */
  logFrom: number;
}

/** A job as a lookup finds it: its record, or `starting` while a process this server started hasn't recorded it. */
interface Lookup {
  record?: JobRecord;
  starting: boolean;
}

interface ToolContext {
  deps: McpDeps;
  /** Jobs this server started that have no record yet, by key; shared by every call. */
  starts: Map<string, Start>;
  signal: AbortSignal;
  /** Reports progress while a call waits, when the client asked for it, so a client that resets its timeout on progress keeps waiting. */
  progress: (message: string) => void;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  call: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** A bad argument or a review that can't start; the client sees it as a failed tool call, not a protocol error. */
class ToolError extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const str = (args: Record<string, unknown>, name: string): string | undefined => {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${name} must be a non-empty string`);
  return value.trim();
};

const int = (args: Record<string, unknown>, name: string, min: number, max: number): number | undefined => {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
};

const strings = (args: Record<string, unknown>, name: string): string[] | undefined => {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ToolError(`${name} must be an array of strings`);
  }
  return value as string[];
};

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const stateOf = (config: Config) => new StateStore(join(config.dataDir, 'state.json'));

/** The job's record as state.json has it now; a new store each time, so other processes' writes count at once. */
const recordOf = (config: Config, key: string) =>
  stateOf(config)
    .list()
    .find((r) => r.key === key);

/** One job as `list_reviews` shows it: what was reviewed, how it ended, and the score once there is one. */
function jobSummary(record: JobRecord, config: Config) {
  const report = record.reportDir ? readReport(record.reportDir, pricesFor(config)) : null;
  return {
    key: record.key,
    repo: record.repo,
    ...(isLocal(record) ? { branch: record.branch ?? null, base: record.base ?? null } : { pr: record.pr }),
    headSha: record.headSha,
    source: record.source,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    route: record.route ?? null,
    score: report?.score ?? null,
    findings: report?.findings ?? null,
    costUsd: report?.cost?.costUsd ?? null,
    error: record.error ?? null,
  };
}

/** Everything a finished job's report says: each reviewer's score and summary, and the findings merged across them. */
function jobDetail(record: JobRecord, config: Config) {
  const summary = jobSummary(record, config);
  const dir = record.reportDir;
  const meta = dir ? readJson(join(dir, 'meta.json')) : null;
  if (!dir || !meta || !Array.isArray(meta.reviewers)) {
    return {
      ...summary,
      reportDir: dir ?? null,
      ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
      reviewers: [],
      findings: [],
    };
  }
  const reviewers = (meta.reviewers as any[]).map((r) => {
    const file = readJson(join(dir, `${r.name}.json`));
    return {
      name: r.name as string,
      harness: r.harness ?? null,
      model: r.model ?? null,
      effort: r.effort ?? null,
      ok: !!r.ok,
      score: r.score ?? null,
      durationMs: r.durationMs ?? null,
      ...(r.ok
        ? {
            summary: file?.verdict?.summary ?? null,
            scoreRationale: file?.verdict?.scoreRationale ?? null,
            dimensions: file?.verdict?.dimensions ?? null,
          }
        : { error: r.error ?? null }),
      findings: (r.ok ? (file?.verdict?.findings ?? []) : []) as Finding[],
    };
  });
  const findings = mergeFindings(
    reviewers.filter((r) => r.ok).map((r) => ({ reviewer: r.name, findings: r.findings })),
  );
  return {
    ...summary,
    findingCounts: summary.findings,
    reportDir: dir,
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    reviewers: reviewers.map(({ findings: _findings, ...r }) => r),
    findings,
  };
}

const logSize = (config: Config) => {
  try {
    return statSync(logFilePath(config.dataDir)).size;
  } catch {
    return 0;
  }
};

/** The mark a process started with `--spawn-id` ends each line it logs with. */
const SPAWN_MARK = / \[mcp:[0-9a-f]{8,32}\]$/;

/**
 * What the process logged since it started: the lines that end with its spawn mark, without the mark. A CLI too old
 * to mark its lines, or one that failed before reading its arguments, marks none; then the lines written since that
 * carry no timestamp and no other process's mark stand in, as the daemon and reviews log timestamped lines.
 */
function startLog(config: Config, start: Start): { lines: string[]; own: boolean } {
  const path = logFilePath(config.dataDir);
  let text = '';
  try {
    text = readRange(path, start.logFrom, statSync(path).size);
  } catch {
    return { lines: [], own: true };
  }
  const all = sanitize(text).split('\n');
  const mark = ` [mcp:${start.id}]`;
  const own = all.filter((line) => line.endsWith(mark)).map((line) => line.slice(0, -mark.length));
  if (own.length > 0) return { lines: own.slice(-10), own: true };
  const unmarked = all.filter((line) => line.trim() && !/^\d\d:\d\d:\d\d /.test(line) && !SPAWN_MARK.test(line));
  return { lines: unmarked.slice(-10), own: false };
}

/** True for a record the start's own process wrote, rather than an earlier review of the same commit. */
const fromStart = (record: JobRecord, start: Start) => Date.parse(record.startedAt) >= start.since - 1000;

/**
 * True while the start's process runs. A live pid counts only while it is still that process: its command line,
 * checked every PID_CHECK_MS, names the start's id. An unreadable command line leaves the pid trusted.
 */
function running(start: Start, deps: McpDeps): boolean {
  if (!deps.isAlive(start.pid)) return false;
  const now = Date.now();
  if (now - start.checkedAt < (deps.pidCheckMs ?? PID_CHECK_MS)) return true;
  start.checkedAt = now;
  const cmd = deps.commandLine(start.pid);
  return cmd === null || cmd.includes(start.id);
}

/**
 * The job as state.json has it now. While a process this server started for it runs and hasn't recorded it, the job
 * is `starting`. When that process exits without recording it, this throws with what the process logged, unless
 * another process has the commit under review, which is what such a process exits for. `quiet` drops such a start
 * instead, for a call about to start the job again.
 */
function lookup(config: Config, key: string, ctx: ToolContext, { quiet = false } = {}): Lookup {
  const record = recordOf(config, key);
  const start = ctx.starts.get(key);
  if (!start) return { record, starting: false };
  if (record && fromStart(record, start)) {
    ctx.starts.delete(key);
    return { record, starting: false };
  }
  if (running(start, ctx.deps)) return { starting: true };
  // It may have recorded the job and exited between the two reads.
  const last = recordOf(config, key);
  ctx.starts.delete(key);
  if (quiet || (last && (fromStart(last, start) || activeJob(last)))) return { record: last, starting: false };
  const { lines, own } = startLog(config, start);
  const where = logFilePath(config.dataDir);
  const quoted = own
    ? `:\n${lines.join('\n')}`
    : `; it logged nothing of its own, but these unattributed lines reached ${where} meanwhile:\n${lines.join('\n')}`;
  throw new ToolError(
    `the review process exited before it recorded the job${lines.length ? quoted : `; see ${where}`}`,
  );
}

/** True while the job may still change: being started, queued, or running. */
const unsettled = (now: Lookup) => now.starting || (!!now.record && activeJob(now.record));

/** Waits until the job finishes or `seconds` pass; returns it as it is then. */
async function waitFor(config: Config, key: string, seconds: number, ctx: ToolContext): Promise<Lookup> {
  const deadline = Date.now() + seconds * 1000;
  const poll = ctx.deps.pollMs ?? 1000;
  let now = lookup(config, key, ctx);
  let lastProgress = Date.now();
  while (unsettled(now) && Date.now() < deadline && !ctx.signal.aborted) {
    await sleep(Math.min(poll, Math.max(deadline - Date.now(), 0)), ctx.signal);
    now = lookup(config, key, ctx);
    if (Date.now() - lastProgress >= 10_000) {
      lastProgress = Date.now();
      ctx.progress(`${now.starting ? 'starting' : (now.record?.status ?? 'unknown')}: ${key}`);
    }
  }
  return now;
}

/**
 * Starts `args` in the background for the job `key`, and waits a little for it to record the job, so a process that
 * fails at once is reported here. Later lookups of the key keep treating it as `starting` until it records the job.
 */
async function startJob(
  config: Config,
  key: string,
  start: Pick<Start, 'repo' | 'pr'>,
  args: string[],
  cwd: string | undefined,
  ctx: ToolContext,
): Promise<Lookup> {
  const since = Date.now();
  const logFrom = logSize(config);
  const id = randomBytes(8).toString('hex');
  const pid = ctx.deps.spawn(config.dataDir, [...args, '--spawn-id', id], cwd);
  // A spawn that failed has no pid, and pid 0 would name this process group, which is always alive.
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ToolError(`could not start the review process (${process.execPath}); see the server's stderr`);
  }
  ctx.starts.set(key, { ...start, pid, id, since, checkedAt: since, logFrom });
  const poll = Math.min(ctx.deps.pollMs ?? 100, 100);
  const deadline = since + (ctx.deps.startWaitMs ?? START_WAIT_MS);
  let now = lookup(config, key, ctx);
  while (now.starting && Date.now() < deadline && !ctx.signal.aborted) {
    await sleep(poll, ctx.signal);
    now = lookup(config, key, ctx);
  }
  return now;
}

/** A job as the tools return it: `starting` until it is recorded, the summary while it runs, then the report. */
function describe(config: Config, key: string, now: Lookup) {
  if (!now.record) return { key, status: 'starting' as const };
  return activeJob(now.record) ? jobSummary(now.record, config) : jobDetail(now.record, config);
}

/** What a start call returns: the job, waited on for `waitSeconds` when asked, with the report once it finished. */
async function started(
  config: Config,
  key: string,
  now: Lookup,
  extra: Record<string, unknown>,
  waitSeconds: number | undefined,
  ctx: ToolContext,
) {
  const latest = waitSeconds ? await waitFor(config, key, waitSeconds, ctx) : now;
  return { ...extra, ...describe(config, key, latest) };
}

/** The note an `alreadyRunning` reply carries when the call asked for reviewers or a route the running job may not use. */
const ignoredNote = (asked: string[]) =>
  asked.length > 0
    ? {
        note: `a review of this commit was already running, so this call's ${asked.join(' and ')} did not apply; the report lists the reviewers it ran`,
      }
    : {};

const WAIT_SECONDS = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_WAIT_SECONDS,
  description: `Seconds to wait for the review to finish before returning (0-${MAX_WAIT_SECONDS}, default 0). Reviews usually take several minutes; when it is still running, call get_review with the key.`,
};

export const TOOLS: Tool[] = [
  {
    name: 'review_branch',
    title: 'Review a branch',
    description:
      'Starts a review-relay review of the commits on a local branch that its base lacks, before any PR exists: the configured reviewer CLIs score it 1-5 and list findings. Posts nothing and needs no GitHub access. Runs in the background and returns the job key at once; read the result with get_review. Uncommitted changes are left out, so commit first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A directory inside the git checkout to review (default: the directory the server started in)',
        },
        base: { type: 'string', description: 'Ref to diff against (default: origin/HEAD, else origin/main)' },
        head: { type: 'string', description: 'Ref to review (default: HEAD)' },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reviewer ids to run instead of routing, such as ["claude", "codex"]',
        },
        route: { type: 'string', description: 'A configured route to use instead of the one the branch matches' },
        waitSeconds: WAIT_SECONDS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async call(args, ctx) {
      const path = str(args, 'path') ?? ctx.deps.cwd;
      const base = str(args, 'base');
      const head = str(args, 'head');
      const route = str(args, 'route');
      const ids = strings(args, 'reviewers');
      const waitSeconds = int(args, 'waitSeconds', 0, MAX_WAIT_SECONDS);
      if (route !== undefined && ids !== undefined) throw new ToolError('pass route or reviewers, not both');

      const config = await ctx.deps.loadConfig(ctx.deps.configPath);
      if (route !== undefined) checkRoute(config, route, 'review');
      const reviewConfig = ids === undefined ? config : withReviewers(config, ids);
      const target = await localTarget(reviewConfig, path, { base, head, route });
      const { job, repo, commits, dirty } = target;
      const key = jobKey(job);
      const stats = await diffStats(repo.localPath, baseRemoteRef(job), job.headSha);
      const pick = pickRoute(reviewConfig, job, stats);
      const extra = {
        branch: job.headRef,
        base: job.baseName,
        commits,
        ...(dirty ? { warning: 'uncommitted changes are left out; commit them to include them' } : {}),
      };

      // An earlier start of this commit that died unrecorded is dropped, so this call starts it again.
      const existing = lookup(config, key, ctx, { quiet: true });
      if (unsettled(existing)) {
        // The running job keeps the reviewers it started with, which this call can't know until its report.
        const asked = [...(ids ? ['reviewers'] : []), ...(route ? ['route'] : [])];
        return {
          alreadyRunning: true,
          ...ignoredNote(asked),
          ...(await started(config, key, existing, extra, waitSeconds, ctx)),
        };
      }
      // The same worker `review -d` starts, on the SHA resolved here, so a later commit isn't picked up.
      const now = await startJob(
        config,
        key,
        { repo: job.repo },
        [
          'review',
          '--worker',
          '--config',
          ctx.deps.configPath,
          '--base',
          job.base!,
          '--base-name',
          job.baseName!,
          '--head',
          job.headSha,
          '--head-name',
          job.headRef!,
          ...(route ? ['--route', route] : []),
          ...(ids ? ['--reviewers', ids.join(',')] : []),
        ],
        repo.localPath,
        ctx,
      );
      return started(config, key, now, { ...extra, reviewerIds: pick.reviewers }, waitSeconds, ctx);
    },
  },
  {
    name: 'review_pr',
    title: 'Review a pull request',
    description:
      'Starts a review-relay review of an open pull request in a configured repo now, even when its head commit was already reviewed. When the repo has postToPr on (the default), the scored review is posted to the PR as a comment. Runs in the background and returns the job key at once; read the result with get_review.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'A configured repo, as owner/name' },
        pr: { type: 'integer', minimum: 1, description: 'Pull request number' },
        route: { type: 'string', description: 'A configured route to use instead of the one the PR matches' },
        waitSeconds: WAIT_SECONDS,
      },
      required: ['repo', 'pr'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async call(args, ctx) {
      const name = str(args, 'repo');
      const pr = int(args, 'pr', 1, Number.MAX_SAFE_INTEGER);
      const route = str(args, 'route');
      const waitSeconds = int(args, 'waitSeconds', 0, MAX_WAIT_SECONDS);
      if (!name || pr === undefined) throw new ToolError('review_pr needs repo and pr');

      const config = await ctx.deps.loadConfig(ctx.deps.configPath);
      const repo = findRepo(config, name);
      if (!repo) {
        throw new ToolError(
          `no configured repo named "${name}" (configured: ${config.repos.map((r) => r.fullName).join(', ') || 'none'})`,
        );
      }
      if (route !== undefined) checkRoute(config, route, 'run');
      const headSha = await ctx.deps.prHead(repo.fullName, pr);
      const key = jobKey({ repo: repo.fullName, headSha });
      const extra = { posts: repo.postToPr };

      // An earlier start of this commit that died unrecorded is dropped, so this call starts it again.
      const existing = lookup(config, key, ctx, { quiet: true });
      if (unsettled(existing)) {
        return {
          alreadyRunning: true,
          ...ignoredNote(route ? ['route'] : []),
          ...(await started(config, key, existing, extra, waitSeconds, ctx)),
        };
      }
      // Pinned to the head looked up here, so the job is recorded under this key even if the PR moves meanwhile;
      // a push since then supersedes it instead.
      const now = await startJob(
        config,
        key,
        { repo: repo.fullName, pr },
        [
          'run',
          '--config',
          ctx.deps.configPath,
          '--repo',
          repo.fullName,
          '--pr',
          String(pr),
          '--head',
          headSha,
          ...(route ? ['--route', route] : []),
        ],
        undefined,
        ctx,
      );
      return started(config, key, now, extra, waitSeconds, ctx);
    },
  },
  {
    name: 'get_review',
    title: 'Get a review',
    description:
      "A review's status and, once it is done, its 1-5 merge confidence score, each reviewer's score and summary, and the findings merged across reviewers (severity, file, line, detail, suggestion). Names the job by key, by repo and pr for the PR's latest review, or by neither for the most recent job. waitSeconds waits for a running review to finish.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The job key that review_branch, review_pr, or list_reviews returned' },
        repo: { type: 'string', description: 'With pr: the repo, as owner/name' },
        pr: { type: 'integer', minimum: 1, description: 'With repo: the PR whose latest review to get' },
        waitSeconds: WAIT_SECONDS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async call(args, ctx) {
      const key = str(args, 'key');
      const repo = str(args, 'repo');
      const pr = int(args, 'pr', 1, Number.MAX_SAFE_INTEGER);
      const waitSeconds = int(args, 'waitSeconds', 0, MAX_WAIT_SECONDS) ?? 0;
      if ((repo === undefined) !== (pr === undefined)) throw new ToolError('pass repo and pr together');
      if (key !== undefined && repo !== undefined) throw new ToolError('pass key, or repo and pr, not both');

      const config = await ctx.deps.loadConfig(ctx.deps.configPath);
      const records = stateOf(config).list();
      const sameRepo = (name: string) => name.toLowerCase() === repo?.toLowerCase();
      const latest = repo ? records.find((r) => !isLocal(r) && sameRepo(r.repo) && r.pr === pr) : records[0];
      // A review this server started that has no record yet is newer than any record from before it started.
      const [newest] = [...ctx.starts]
        .filter(([, start]) => !repo || (sameRepo(start.repo) && start.pr === pr))
        .toSorted(([, a], [, b]) => b.since - a.since);
      const startedKey = newest && (!latest || newest[1].since > Date.parse(latest.startedAt)) ? newest[0] : undefined;
      const found = key ?? startedKey ?? latest?.key;
      const now = found ? lookup(config, found, ctx) : { starting: false };
      if (!found || (!unsettled(now) && !now.record)) {
        throw new ToolError(
          key ? `no review job with key "${key}"` : repo ? `no review of ${repo}#${pr} yet` : 'no review jobs yet',
        );
      }
      return describe(config, found, waitSeconds ? await waitFor(config, found, waitSeconds, ctx) : now);
    },
  },
  {
    name: 'list_reviews',
    title: 'List reviews',
    description:
      'Recent review-relay jobs, newest first: PR reviews and local branch reviews, with each one’s status, score, finding counts, and cost.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Only jobs for this repo, as owner/name' },
        pr: { type: 'integer', minimum: 1, description: 'Only reviews of this pull request' },
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'Only jobs with this status',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Jobs to return (default 20)' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async call(args, ctx) {
      const repo = str(args, 'repo');
      const pr = int(args, 'pr', 1, Number.MAX_SAFE_INTEGER);
      const status = str(args, 'status') as JobStatus | undefined;
      if (status !== undefined && !STATUSES.includes(status)) {
        throw new ToolError(`status must be one of ${STATUSES.join(', ')}`);
      }
      const limit = int(args, 'limit', 1, 100) ?? 20;
      const config = await ctx.deps.loadConfig(ctx.deps.configPath);
      const matching = stateOf(config)
        .list()
        .filter((r) => !repo || r.repo.toLowerCase() === repo.toLowerCase())
        .filter((r) => pr === undefined || (!isLocal(r) && r.pr === pr))
        .filter((r) => !status || r.status === status);
      return { total: matching.length, jobs: matching.slice(0, limit).map((r) => jobSummary(r, config)) };
    },
  },
];

const INSTRUCTIONS =
  'review-relay runs the local agent CLIs configured in ~/.review-relay/config.json as code reviewers and scores a change 1-5 for merge confidence. To check your work before opening a PR, commit it, call review_branch, then call get_review with the returned key (and waitSeconds) until its status is done, and address the findings. Reviews usually take several minutes.';

/**
 * The protocol, apart from the transport: `handle` takes one message and calls `send` with its reply, if any.
 * Requests are handled concurrently, so a waiting `get_review` doesn't hold up the next request.
 */
export function createMcpServer(deps: McpDeps, send: (message: Json) => void) {
  const inflight = new Map<string | number, AbortController>();
  const starts = new Map<string, Start>();
  const reply = (id: string | number | null, result: Json): Json => ({ jsonrpc: '2.0', id, result });
  const error = (id: string | number | null, code: number, message: string): Json => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  async function callTool(id: string | number, params: any): Promise<Json | undefined> {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return error(id, -32602, `unknown tool "${params?.name}"`);
    const args = params?.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return error(id, -32602, 'arguments must be an object');
    const controller = new AbortController();
    inflight.set(id, controller);
    // oxlint-disable-next-line no-underscore-dangle -- the protocol names the field `_meta`.
    const token = params?._meta?.progressToken;
    let step = 0;
    const progress = (message: string) => {
      if (token === undefined) return;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++step, message },
      });
    };
    try {
      const result = (await tool.call(args, { deps, starts, signal: controller.signal, progress })) as Json;
      if (controller.signal.aborted) return undefined;
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (e) {
      if (controller.signal.aborted) return undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ToolError)) deps.log(`review-relay mcp: ${tool.name} failed: ${message}`);
      return reply(id, { content: [{ type: 'text', text: message }], isError: true });
    } finally {
      inflight.delete(id);
    }
  }

  async function request(id: string | number, method: string, params: any): Promise<Json | undefined> {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]!,
          capabilities: { tools: {} },
          serverInfo: { name: 'review-relay', title: 'review-relay', version: deps.version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: TOOLS.map(({ call: _call, ...tool }) => tool) as unknown as Json,
        });
      case 'tools/call':
        return callTool(id, params);
      default:
        return error(id, -32601, `method not found: ${method}`);
    }
  }

  function notification(method: string, params: any) {
    // A cancelled request gets no reply; its wait stops at once.
    if (method === 'notifications/cancelled') inflight.get(params?.requestId)?.abort();
  }

  /** The reply to one message, or undefined for a notification, a reply, or a cancelled call. */
  async function respond(message: unknown): Promise<Json | undefined> {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return error(null, -32600, 'invalid request');
    const m = message as JsonRpcMessage;
    if (typeof m.method !== 'string') {
      // A reply, which this server never asks for, is dropped.
      if ('result' in m || 'error' in m) return undefined;
      return error(m.id ?? null, -32600, 'invalid request');
    }
    if (m.id === undefined || m.id === null) {
      notification(m.method, m.params);
      return undefined;
    }
    try {
      return await request(m.id, m.method, m.params);
    } catch (e) {
      return error(m.id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    /** Handles one line of input, a message or a batch of them; resolves once its reply, if any, is sent. */
    async handle(line: string): Promise<void> {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return send(error(null, -32700, 'parse error'));
      }
      if (!Array.isArray(parsed)) {
        const answer = await respond(parsed);
        if (answer !== undefined) send(answer);
        return;
      }
      // A batch, which 2025-03-26 clients may send: one array of the replies, or nothing when none are due.
      if (parsed.length === 0) return send(error(null, -32600, 'invalid request'));
      const answers = (await Promise.all(parsed.map(respond))).filter((a) => a !== undefined);
      if (answers.length > 0) send(answers);
    },
    /** Stops every waiting call without replying, as on shutdown. */
    close() {
      for (const controller of inflight.values()) controller.abort();
    },
  };
}

/** Serves MCP on stdin and stdout until stdin closes. */
export async function serveMcp(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const handled = server.handle(line).finally(() => pending.delete(handled));
      pending.add(handled);
    }
  }
  if (buffer.trim()) await server.handle(buffer);
  // The client hung up, so nobody reads replies to calls still waiting.
  server.close();
  await Promise.allSettled(pending);
}
