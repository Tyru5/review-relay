import { basename } from 'node:path';
import type { Config } from './config.ts';
import { LOCKFILES, pathsOf, type DiffStats } from './diffstats.ts';
import { HARNESS_NAMES, HARNESSES } from './reviewers/index.ts';
import type { JobSource, ResolvedJob, ReviewerId } from './types.ts';
import { fmtDuration } from './ui.ts';

/** Route names, like reviewer ids, so a mention can name one. */
export const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const SOURCES: JobSource[] = ['greptile', 'github', 'mention', 'manual'];

const GLOB_CONDITIONS = ['repos', 'baseBranches', 'paths', 'onlyPaths'] as const;
const COUNT_CONDITIONS = ['minLines', 'maxLines', 'minFiles', 'maxFiles'] as const;

/** Every condition, in the order routes check them, so the first one that fails is always the same. */
const CONDITIONS = [
  'repos',
  'baseBranches',
  'sources',
  'paths',
  'onlyPaths',
  ...COUNT_CONDITIONS,
  'wideImpact',
] as const;
type Condition = (typeof CONDITIONS)[number];

/**
 * The conditions a skip route may use: where the PR is, how it was triggered, and that it changes only some paths.
 * `paths` would skip code that changed next to docs, and size or `wideImpact` would let a small change skip review.
 */
const SKIP_CONDITIONS: Condition[] = ['onlyPaths', 'repos', 'baseBranches', 'sources'];

const ROUTE_FIELDS = ['name', 'when', 'reviewers', 'skip', 'timeoutMs'];

export interface When {
  repos?: string[];
  baseBranches?: string[];
  sources?: JobSource[];
  paths?: string[];
  onlyPaths?: string[];
  minLines?: number;
  maxLines?: number;
  minFiles?: number;
  maxFiles?: number;
  wideImpact?: boolean;
}

export interface Route {
  name: string;
  when: When;
  /** Who reviews; absent on a skip route. */
  reviewers?: ReviewerId[];
  skip: boolean;
  /** Per-reviewer timeout in place of the global one. */
  timeoutMs?: number;
}

/**
 * Paths that steer coding agents, matched ignoring case. A skip route never skips a PR that changes one: a PR telling
 * reviewers to "always score 5/5" in AGENTS.md must not merge unreviewed because a docs route matched it.
 */
const AGENT_FILES = [
  '**/agents.md',
  '**/claude.md',
  '**/gemini.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.clinerules/**',
  '.mcp.json',
  '.claude/**',
  '.codex/**',
  '.cursor/**',
  '.windsurf/**',
  '.github/instructions/**',
  '.github/prompts/**',
  // Every path a supported CLI loads as its own config, so a new harness extends the list.
  ...HARNESS_NAMES.flatMap((name) => (HARNESSES[name].projectFiles ?? []).flatMap((path) => [path, `${path}/**`])),
].map((pattern) => new Bun.Glob(pattern.toLowerCase()));

export const isAgentFile = (path: string) => AGENT_FILES.some((glob) => glob.match(path.toLowerCase()));

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** False when a `[` or `{` never closes. Bun.Glob accepts such a pattern, but it never matches. */
function balanced(pattern: string): boolean {
  let square = 0;
  let curly = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (c === '[') square++;
    else if (c === ']' && square > 0) square--;
    else if (c === '{') curly++;
    else if (c === '}' && curly > 0) curly--;
  }
  return square === 0 && curly === 0;
}

const matches = (pattern: string, text: string) => new Bun.Glob(pattern).match(text);

const matchesRepo = (pattern: string, repo: string) => matches(pattern.toLowerCase(), repo.toLowerCase());

function parseWhen(raw: unknown, at: string, repos: string[]): When {
  if (!isObject(raw)) throw new Error(`${at}: when must be an object of conditions`);
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error(`${at}: when needs at least one condition`);
  const when: Record<string, unknown> = {};
  for (const key of keys) {
    const value = raw[key];
    const condition = `${at}: when.${key}`;
    if ((GLOB_CONDITIONS as readonly string[]).includes(key)) {
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v)) {
        throw new Error(`${condition} must be a non-empty list of globs`);
      }
      for (const pattern of value as string[]) {
        if (!balanced(pattern)) throw new Error(`${condition} "${pattern}" has a [ or { that never closes`);
        if (key === 'repos' && !repos.some((repo) => matchesRepo(pattern, repo))) {
          throw new Error(`${condition} "${pattern}" matches no configured repo`);
        }
      }
    } else if (key === 'sources') {
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => SOURCES.includes(v))) {
        throw new Error(`${condition} must list some of ${SOURCES.join(', ')}`);
      }
    } else if ((COUNT_CONDITIONS as readonly string[]).includes(key)) {
      if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${condition} must be a whole number`);
    } else if (key === 'wideImpact') {
      if (typeof value !== 'boolean') throw new Error(`${condition} must be true or false`);
    } else {
      throw new Error(`${at}: unknown condition ${key} (expected ${CONDITIONS.join(', ')})`);
    }
    when[key] = value;
  }
  for (const unit of ['Lines', 'Files']) {
    const [min, max] = [when[`min${unit}`], when[`max${unit}`]] as (number | undefined)[];
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`${at}: when.min${unit} is above when.max${unit}, so the route never matches`);
    }
  }
  return when as When;
}

/**
 * Validates `routes` against the reviewer ids and repos the config defines. Routes are new, so every mistake stops
 * the load, with the route's index and name in the message.
 */
export function parseRoutes(raw: unknown, known: { reviewers: ReviewerId[]; repos: string[] }): Route[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('routes must be a list');
  const names = new Set<string>();
  return raw.map((value, i): Route => {
    if (!isObject(value)) throw new Error(`routes[${i}] must be an object`);
    const { name } = value;
    if (typeof name !== 'string' || !ROUTE_NAME.test(name)) {
      throw new Error(`routes[${i}]: name must be lowercase letters, digits, and dashes, up to 32 characters`);
    }
    const at = `routes[${i}] "${name}"`;
    if (names.has(name)) throw new Error(`${at}: another route has this name`);
    names.add(name);
    for (const key of Object.keys(value)) {
      if (!ROUTE_FIELDS.includes(key))
        throw new Error(`${at}: unknown key ${key} (expected ${ROUTE_FIELDS.join(', ')})`);
    }
    const when = parseWhen(value.when, at, known.repos);
    if (value.skip !== undefined && value.skip !== true) throw new Error(`${at}: skip must be true`);
    const skip = value.skip === true;
    if (skip === (value.reviewers !== undefined)) throw new Error(`${at}: set exactly one of reviewers and skip`);
    if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0)) {
      throw new Error(`${at}: timeoutMs must be a positive whole number of milliseconds`);
    }

    if (skip) {
      if (value.timeoutMs !== undefined) throw new Error(`${at}: skip can't use timeoutMs`);
      const unsafe = (Object.keys(when) as Condition[]).filter((key) => !SKIP_CONDITIONS.includes(key));
      if (unsafe.length > 0) {
        throw new Error(
          `${at}: skip can't use ${unsafe.join(' or ')}; it may only use ${SKIP_CONDITIONS.join(', ')}, so send small PRs to a cheap route instead`,
        );
      }
      if (when.sources?.every((source) => source === 'mention' || source === 'manual')) {
        throw new Error(`${at}: never skips anything, because mentions and run always review`);
      }
      return { name, when, skip: true };
    }

    const { reviewers } = value;
    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      throw new Error(`${at}: reviewers must list at least one reviewer id`);
    }
    for (const [j, id] of reviewers.entries()) {
      if (typeof id !== 'string' || !known.reviewers.includes(id)) {
        throw new Error(
          `${at}: unknown reviewer ${JSON.stringify(id)} (expected a CLI name or a models key with a harness)`,
        );
      }
      if (reviewers.indexOf(id) !== j) throw new Error(`${at}: lists reviewer "${id}" twice`);
    }
    return {
      name,
      when,
      reviewers: reviewers as ReviewerId[],
      skip: false,
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
    };
  });
}

/** What routes match on: facts git and the trigger report, never anything a reviewer or a model decided. */
export interface RouteFacts {
  repo: string;
  baseRef: string;
  source: JobSource;
  stats: DiffStats;
}

export const factsOf = (job: ResolvedJob, stats: DiffStats): RouteFacts => ({
  repo: job.repo,
  baseRef: job.baseRef,
  source: job.source,
  stats,
});

/** Up to three items, then a count of the rest. */
const some = (items: string[]) =>
  items.length <= 3 ? items.join(', ') : `${items.slice(0, 3).join(', ')} (+${items.length - 3} more)`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Whether one condition holds: what made it hold, or why it didn't. */
function check(condition: Condition, when: When, facts: RouteFacts): { ok: boolean; why: string } {
  const { stats } = facts;
  const lines = stats.counted.additions + stats.counted.deletions;
  const files = stats.counted.files;
  const anyOf = (patterns: string[], path: string) => patterns.some((pattern) => matches(pattern, path));
  switch (condition) {
    case 'repos': {
      const ok = when.repos!.some((pattern) => matchesRepo(pattern, facts.repo));
      return { ok, why: ok ? `repo ${facts.repo}` : `repos: ${facts.repo} matches none of ${when.repos!.join(', ')}` };
    }
    case 'baseBranches': {
      const ok = anyOf(when.baseBranches!, facts.baseRef);
      return {
        ok,
        why: ok
          ? `base ${facts.baseRef}`
          : `baseBranches: ${facts.baseRef} matches none of ${when.baseBranches!.join(', ')}`,
      };
    }
    case 'sources': {
      const ok = when.sources!.includes(facts.source);
      return {
        ok,
        why: ok ? `source ${facts.source}` : `sources: ${facts.source} is not ${when.sources!.join(' or ')}`,
      };
    }
    case 'paths': {
      const hits = stats.changed.filter((file) => pathsOf(file).some((path) => anyOf(when.paths!, path)));
      return hits.length > 0
        ? { ok: true, why: `paths: ${some(hits.map((file) => file.path))}` }
        : { ok: false, why: `paths: no changed file matches ${when.paths!.join(', ')}` };
    }
    case 'onlyPaths': {
      if (stats.changed.length === 0) return { ok: false, why: 'onlyPaths: no files changed' };
      const miss = stats.changed.flatMap(pathsOf).find((path) => !anyOf(when.onlyPaths!, path));
      return miss === undefined
        ? { ok: true, why: `onlyPaths: ${plural(stats.changed.length, 'file')}` }
        : { ok: false, why: `onlyPaths: ${miss} matches none of ${when.onlyPaths!.join(', ')}` };
    }
    case 'minLines':
      return lines >= when.minLines!
        ? { ok: true, why: `${plural(lines, 'line')}, at least ${when.minLines}` }
        : { ok: false, why: `minLines: ${lines} is under ${when.minLines}` };
    case 'maxLines':
      return lines <= when.maxLines!
        ? { ok: true, why: `${plural(lines, 'line')}, at most ${when.maxLines}` }
        : { ok: false, why: `maxLines: ${lines} is over ${when.maxLines}` };
    case 'minFiles':
      return files >= when.minFiles!
        ? { ok: true, why: `${plural(files, 'file')}, at least ${when.minFiles}` }
        : { ok: false, why: `minFiles: ${files} is under ${when.minFiles}` };
    case 'maxFiles':
      return files <= when.maxFiles!
        ? { ok: true, why: `${plural(files, 'file')}, at most ${when.maxFiles}` }
        : { ok: false, why: `maxFiles: ${files} is over ${when.maxFiles}` };
    case 'wideImpact': {
      const wide = stats.sensitiveFiles;
      if (when.wideImpact) {
        return wide.length > 0
          ? { ok: true, why: `wide-impact: ${some(wide)}` }
          : { ok: false, why: 'wideImpact: no wide-impact files changed' };
      }
      return wide.length === 0
        ? { ok: true, why: 'no wide-impact files' }
        : { ok: false, why: `wideImpact: ${some(wide)} changed` };
    }
  }
}

export interface RouteVerdict {
  route: Route;
  matched: boolean;
  /** Why it matched, or the first condition that failed. */
  detail: string;
  /** Why a matching skip route doesn't apply to this PR. */
  passedOver?: string;
}

/** Checks every route against the PR, for picking one and for `review-relay route`. */
export function traceRoutes(routes: Route[], facts: RouteFacts): RouteVerdict[] {
  const explicit = facts.source === 'mention' || facts.source === 'manual';
  const agentFile = facts.stats.changed.flatMap(pathsOf).find(isAgentFile);
  return routes.map((route) => {
    const checks = CONDITIONS.filter((condition) => route.when[condition] !== undefined).map((condition) =>
      check(condition, route.when, facts),
    );
    const failed = checks.find((result) => !result.ok);
    if (failed) return { route, matched: false, detail: failed.why };
    const verdict: RouteVerdict = { route, matched: true, detail: checks.map((result) => result.why).join('; ') };
    if (route.skip && explicit) {
      return { ...verdict, passedOver: `${facts.source === 'mention' ? 'a mention' : 'run'} never skips` };
    }
    if (route.skip && agentFile) return { ...verdict, passedOver: `${agentFile} is an agent file` };
    return verdict;
  });
}

/** The route that decided a review: its name, why it applied, and whether the request named it. */
export interface RouteChoice {
  name: string;
  reason: string;
  forced: boolean;
}

export interface RoutePick {
  /** Undefined when no route matched and `reviewers` runs. */
  route?: RouteChoice;
  skip: boolean;
  reviewers: ReviewerId[];
  timeoutMs: number;
}

/**
 * The review a PR gets: a non-skip route the request named, else the first route that matches and applies, else the
 * fallback `reviewers`.
 */
export function pickRoute(
  config: { routes: Route[]; reviewers: ReviewerId[]; timeoutMs: number },
  job: ResolvedJob,
  stats: DiffStats,
): RoutePick {
  const named = job.route ? config.routes.find((route) => route.name === job.route && !route.skip) : undefined;
  if (named) {
    const reason = job.requestedBy ? `requested by @${job.requestedBy}` : 'requested with run --route';
    return {
      route: { name: named.name, reason, forced: true },
      skip: false,
      reviewers: named.reviewers!,
      timeoutMs: named.timeoutMs ?? config.timeoutMs,
    };
  }
  const winner = traceRoutes(config.routes, factsOf(job, stats)).find((v) => v.matched && !v.passedOver);
  if (!winner) return { skip: false, reviewers: config.reviewers, timeoutMs: config.timeoutMs };
  const route = { name: winner.route.name, reason: winner.detail, forced: false };
  return winner.route.skip
    ? { route, skip: true, reviewers: [], timeoutMs: config.timeoutMs }
    : {
        route,
        skip: false,
        reviewers: winner.route.reviewers!,
        timeoutMs: winner.route.timeoutMs ?? config.timeoutMs,
      };
}

/** `review-relay route`: the PR's facts, every route's verdict, and the review the PR gets, without running it. */
export function explainRoutes(config: Config, job: ResolvedJob, stats: DiffStats): string[] {
  const lockfiles = stats.changed.filter((file) => LOCKFILES.has(basename(file.path))).map((file) => file.path);
  const { counted } = stats;
  const lines = [
    `${job.repo} #${job.pr} @ ${job.headSha.slice(0, 8)} · base ${job.baseRef} · source ${job.source}`,
    `${stats.files} files, +${stats.additions} -${stats.deletions}${
      lockfiles.length > 0
        ? ` · counted ${counted.files} files, +${counted.additions} -${counted.deletions} (${some(lockfiles)} left out)`
        : ''
    }`,
    ...(stats.sensitiveFiles.length > 0 ? [`wide-impact: ${some(stats.sensitiveFiles)}`] : []),
    '',
  ];
  const pick = pickRoute(config, job, stats);
  if (config.routes.length === 0) {
    lines.push('no routes configured, so every PR gets reviewers');
  } else {
    const width = Math.max(...config.routes.map((route) => route.name.length));
    for (const verdict of traceRoutes(config.routes, factsOf(job, stats))) {
      const name = verdict.route.name.padEnd(width);
      const winner = verdict.route.name === pick.route?.name;
      const text = !verdict.matched
        ? `✗ ${name}  ${verdict.detail}`
        : verdict.passedOver
          ? `- ${name}  matches (${verdict.detail}), but ${verdict.passedOver}`
          : winner || !pick.route
            ? `✔ ${name}  ${verdict.detail}`
            : `✔ ${name}  ${verdict.detail}, shadowed by ${pick.route.name}`;
      lines.push(`  ${text}`);
    }
    lines.push('');
  }
  if (pick.skip) return [...lines, `route ${pick.route!.name} · skip, so nothing runs`];
  lines.push(
    `${pick.route ? `route ${pick.route.name}` : 'no route matched, so reviewers runs'} · timeout ${fmtDuration(pick.timeoutMs)}`,
  );
  const rows = pick.reviewers.map((id) => {
    const entry = config.models[id]!;
    return [id, entry.harness, entry.model ?? 'default model', entry.effort ?? ''];
  });
  const widths = [0, 1, 2].map((col) => Math.max(...rows.map((row) => row[col]!.length)));
  for (const row of rows) lines.push(`  ${row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ')}`.trimEnd());
  return lines;
}
