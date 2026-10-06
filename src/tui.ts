/**
 * `review-relay tui`: a live terminal view of the review jobs. It reads what the daemon writes (`state.json`, the
 * report folders, `daemon.log`) and polls for changes, since the daemon exposes no query API. From the list a job
 * opens into its scores, findings, and the posted comment, or into its log lines; a PR can be re-reviewed, opened in
 * the browser, or have its URL copied.
 *
 * Like `setup`, the screen is a pure state machine: `reduce` applies a key, `renderTui` draws, and side effects
 * (spawning a run, opening a browser) come back as an `effect` the loop performs.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { inspectDaemon, logFilePath, readLast, spawnDetached, type DaemonState } from './daemon.ts';
import { reportDirFor } from './report.ts';
import type { JobRecord, JobStatus } from './state.ts';
import { readReport, renderStatus, type ReportSummary } from './status.ts';
import { moved, runScreen, windowed } from './term.ts';
import { fmtDuration, sanitize, styles, tildify, type Styles, type Tone } from './ui.ts';
import { mergeFindings, type Finding, type MergedFinding, type Verdict } from './verdict.ts';

const STATUSES: JobStatus[] = ['running', 'done', 'failed', 'skipped'];
const STATUS_TONES: Record<JobStatus, Tone> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'info',
};
/** Log lines kept per job view; the file itself is read from the end. */
const LOG_LINES = 300;
const FLASH_MS = 4000;

export const prUrl = (job: { repo: string; pr: number }) => `https://github.com/${job.repo}/pull/${job.pr}`;

/**
 * The jobs in `state.json` as they are on disk. Unlike `StateStore`, this keeps `running` records as running (the
 * store rewrites them as failed for crash recovery), since the TUI shows in-flight reviews.
 */
export function readJobs(path: string): JobRecord[] {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (r): r is JobRecord =>
        !!r &&
        typeof r === 'object' &&
        typeof r.key === 'string' &&
        typeof r.repo === 'string' &&
        STATUSES.includes(r.status),
    )
    .toSorted((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** A reviewer's file in the report folder: its verdict, or why it failed. */
export interface ReviewerOutput {
  name: string;
  verdict?: Verdict;
  error?: string;
}

/** Everything the detail view shows for a finished job, read once from its report folder. */
export interface JobDetail {
  summary: ReportSummary | null;
  /** `meta.json` fields the summary leaves out (model, effort, refs). */
  meta: Record<string, any> | null;
  reviewers: ReviewerOutput[];
  findings: MergedFinding[];
  /** The posted comment, without the hidden marker line. */
  comment: string[];
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const isFinished = (job: JobRecord) => job.status !== 'running';

/** What the TUI reads from the data folder, cached where a job can no longer change. */
export class JobStore {
  jobs: JobRecord[] = [];
  private seen = '';
  private readonly reports = new Map<string, ReportSummary | null>();
  private readonly details = new Map<string, JobDetail>();

  constructor(readonly dataDir: string) {}

  /** Re-reads `state.json` when its size or mtime changed; returns true when the list was reloaded. */
  refresh(): boolean {
    const path = join(this.dataDir, 'state.json');
    let stamp = '';
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp === this.seen) return false;
    this.seen = stamp;
    this.jobs = readJobs(path);
    return true;
  }

  private dirOf(job: JobRecord) {
    return job.reportDir ?? reportDirFor(this.dataDir, job);
  }

  /** Scores and finding counts; null while running or when the job never got a report. */
  report(job: JobRecord): ReportSummary | null {
    if (!isFinished(job)) return null;
    if (!this.reports.has(job.key)) this.reports.set(job.key, readReport(this.dirOf(job)));
    return this.reports.get(job.key)!;
  }

  detail(job: JobRecord): JobDetail {
    const cached = this.details.get(job.key);
    if (cached) return cached;
    const dir = this.dirOf(job);
    const summary = this.report(job);
    const meta = isFinished(job) ? readJson(join(dir, 'meta.json')) : null;
    const reviewers: ReviewerOutput[] = (summary?.reviewers ?? []).map((r) => {
      const file = readJson(join(dir, `${r.name}.json`));
      return { name: r.name, verdict: file?.verdict, error: file?.error ?? r.error };
    });
    const findings = mergeFindings(
      reviewers.flatMap((r) => (r.verdict ? [{ reviewer: r.name, findings: r.verdict.findings as Finding[] }] : [])),
    );
    let comment: string[] = [];
    try {
      comment = sanitize(readFileSync(join(dir, 'comment.md'), 'utf8'))
        .split('\n')
        .filter((line) => !line.startsWith('<!--'));
      while (comment.length && !comment.at(-1)) comment.pop();
    } catch {
      // No comment written: a skipped job, or every reviewer failed before the report.
    }
    const detail = { summary, meta, reviewers, findings, comment };
    if (isFinished(job)) this.details.set(job.key, detail);
    return detail;
  }

  /** The tail of `daemon.log`, cleaned of escapes; narrowed to the lines about `job` when given. */
  log(job?: JobRecord): string[] {
    let lines: string[];
    try {
      lines = readLast(logFilePath(this.dataDir), job ? LOG_LINES * 10 : LOG_LINES);
    } catch {
      return [];
    }
    if (job) {
      const tag = `[${job.repo}]`;
      const pr = `PR #${job.pr}`;
      lines = lines.filter((l) => l.includes(tag) && (l.includes(pr) || l.includes(job.key))).slice(-LOG_LINES);
    }
    return lines.map(sanitize);
  }
}

export type View = 'list' | 'detail' | 'log' | 'help';

export type Effect = { kind: 'rerun'; job: JobRecord } | { kind: 'open'; url: string } | { kind: 'copy'; text: string };

export interface TuiState {
  view: View;
  /** Key of the highlighted job, so the cursor follows it as the list changes; the top job when unset or gone. */
  selected?: string;
  /** Text narrowing the list to jobs whose row contains it. */
  filter?: string;
  filtering: boolean;
  /** Only jobs with this status are listed. */
  status?: JobStatus;
  /** Top line shown in the detail and log views. */
  scroll: number;
  /** The log view shows the whole daemon log instead of the selected job's lines. */
  wholeLog: boolean;
  /** The log view keeps its end in view as lines arrive. */
  follow: boolean;
  confirm?: 'rerun';
  flash?: { text: string; tone: Tone; until: number };
  /** A side effect for the loop to perform and clear. */
  effect?: Effect;
  done?: boolean;
}

export interface TuiContext {
  store: JobStore;
  daemon: DaemonState | null;
  reviewers: string[];
  now: number;
  height: number;
  width: number;
}

export const initialState = (): TuiState => ({
  view: 'list',
  filtering: false,
  scroll: 0,
  wholeLog: false,
  follow: true,
});

const rowText = (job: JobRecord) =>
  [job.status, job.repo, `#${job.pr}`, job.headSha, job.source, job.route ?? '', job.error ?? '']
    .join(' ')
    .toLowerCase();

/** The jobs the list shows after the status and text filters, newest first. */
export function visible(state: TuiState, jobs: JobRecord[]): JobRecord[] {
  const text = state.filter?.toLowerCase();
  return jobs.filter((job) => (!state.status || job.status === state.status) && (!text || rowText(job).includes(text)));
}

/** Index of the selected job in `list`, or 0 when it isn't there. */
const cursorOf = (state: TuiState, list: JobRecord[]) =>
  Math.max(
    0,
    list.findIndex((job) => job.key === state.selected),
  );

const selectedJob = (state: TuiState, ctx: TuiContext): JobRecord | undefined => {
  const list = visible(state, ctx.store.jobs);
  return list[cursorOf(state, list)];
};

const flash = (state: TuiState, text: string, ctx: TuiContext, tone: Tone = 'info'): TuiState => ({
  ...state,
  flash: { text, tone, until: ctx.now + FLASH_MS },
});

/** Lines above and below the body on every view: the two header lines and a blank, then a blank and the hint. */
const HEAD = 3;
const FOOT = 2;
const room = (ctx: TuiContext, extra = 0) => Math.max(1, ctx.height - HEAD - FOOT - extra);

/** Keys that act on the highlighted job from the list and detail views. */
function jobKeys(state: TuiState, key: string, ctx: TuiContext): TuiState | undefined {
  const job = selectedJob(state, ctx);
  if (!job) return undefined;
  switch (key) {
    case 'r':
      if (job.status === 'running') return flash(state, `${job.repo} #${job.pr} is being reviewed now`, ctx, 'warning');
      return { ...state, confirm: 'rerun' };
    case 'o':
      return { ...state, effect: { kind: 'open', url: prUrl(job) } };
    case 'y':
      return { ...state, effect: { kind: 'copy', text: prUrl(job) } };
    case 'l':
      return { ...state, view: 'log', wholeLog: false, follow: true, scroll: 0 };
    case 'L':
      return { ...state, view: 'log', wholeLog: true, follow: true, scroll: 0 };
    default:
      return undefined;
  }
}

/**
 * Scrolls a body of `total` lines shown in `lines` rows; undefined when `key` isn't a scroll key. A following log
 * view scrolls from its end.
 */
function scrolled(state: TuiState, key: string, total: number, lines: number): TuiState | undefined {
  const max = Math.max(0, total - lines);
  const page = Math.max(1, lines - 1);
  const at = state.view === 'log' && state.follow ? max : Math.min(state.scroll, max);
  const next: Record<string, number> = {
    up: at - 1,
    k: at - 1,
    down: at + 1,
    j: at + 1,
    pageup: at - page,
    pagedown: at + page,
    home: 0,
    g: 0,
    end: max,
    G: max,
  };
  if (!(key in next)) return undefined;
  const scroll = Math.min(max, Math.max(0, next[key]!));
  return { ...state, scroll, follow: scroll >= max && (key === 'G' || key === 'end' || state.follow) };
}

/** Keys while the filter input is open; mirrors setup's: arrows still move, enter keeps the filter, escape clears it. */
function filtered(state: TuiState, key: string, ctx: TuiContext): TuiState {
  const text = state.filter ?? '';
  const set = (filter: string) => ({ ...state, filter: filter || undefined });
  if (key === 'escape') return { ...set(''), filtering: false };
  if (key === 'enter') return { ...state, filtering: false };
  if (key === 'backspace') return set(text.slice(0, -1));
  if (key === 'ctrl-u') return set('');
  if (key === 'up' || key === 'down') return listMove(state, key, ctx) ?? state;
  if (key === 'space') return set(`${text} `);
  return key.length === 1 && key > ' ' ? set(text + key) : state;
}

function listMove(state: TuiState, key: string, ctx: TuiContext): TuiState | undefined {
  const list = visible(state, ctx.store.jobs);
  const at = moved(cursorOf(state, list), key, list.length, Math.max(1, room(ctx, 1) - 1));
  return at === undefined ? undefined : { ...state, selected: list[at]!.key };
}

/** Applies one key. Sets `done` to quit and `effect` for the loop to perform. */
export function reduce(state: TuiState, key: string, ctx: TuiContext): TuiState {
  if (key === 'ctrl-c') return { ...state, done: true };
  const base: TuiState = { ...state, effect: undefined };
  if (state.confirm) {
    const job = selectedJob(state, ctx);
    const next = { ...base, confirm: undefined };
    if (key === 'y' && job) return { ...next, effect: { kind: 'rerun', job } };
    return flash(next, 'cancelled', ctx, 'muted');
  }
  if (state.view === 'help') return { ...base, view: 'list' };
  if (state.filtering) return filtered(base, key, ctx);

  if (state.view === 'list') {
    const stepped = listMove(base, key, ctx);
    if (stepped) return stepped;
    const list = visible(state, ctx.store.jobs);
    switch (key) {
      case '/':
        return { ...base, filtering: true };
      case 's': {
        const at = state.status ? STATUSES.indexOf(state.status) + 1 : 0;
        return { ...base, status: STATUSES[at] };
      }
      case 'enter':
      case 'right':
        return list.length ? { ...base, view: 'detail', scroll: 0 } : base;
      case '?':
        return { ...base, view: 'help' };
      case 'escape':
        if (state.filter) return { ...base, filter: undefined };
        if (state.status) return { ...base, status: undefined };
        return { ...base, done: true };
      case 'q':
        return { ...base, done: true };
      default:
        return jobKeys(base, key, ctx) ?? base;
    }
  }

  if (state.view === 'detail') {
    const job = selectedJob(state, ctx);
    const total = job ? detailLines(job, ctx, styles(false)).length : 0;
    const scroll = scrolled(base, key, total, room(ctx));
    if (scroll) return scroll;
    const list = visible(state, ctx.store.jobs);
    const at = cursorOf(state, list);
    switch (key) {
      case 'n':
      case 'right':
        return at < list.length - 1 ? { ...base, selected: list[at + 1]!.key, scroll: 0 } : base;
      case 'p':
        return at > 0 ? { ...base, selected: list[at - 1]!.key, scroll: 0 } : base;
      case 'escape':
      case 'q':
      case 'left':
      case 'backspace':
        return { ...base, view: 'list' };
      case '?':
        return { ...base, view: 'help' };
      default:
        return jobKeys(base, key, ctx) ?? base;
    }
  }

  // Log view.
  const lines = ctx.store.log(state.wholeLog ? undefined : selectedJob(state, ctx));
  // One body line is the log's title.
  const scroll = scrolled(base, key, lines.length, room(ctx) - 1);
  if (scroll) return scroll;
  switch (key) {
    case 'L':
      return { ...base, wholeLog: !state.wholeLog, follow: true, scroll: 0 };
    case 'escape':
    case 'q':
    case 'left':
    case 'backspace':
      return { ...base, view: 'list' };
    case '?':
      return { ...base, view: 'help' };
    default:
      return base;
  }
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const scoreTone = (n: number): Tone => (n >= 4 ? 'success' : n === 3 ? 'warning' : 'danger');
const SEVERITY_TONES: Record<string, Tone> = { critical: 'danger', major: 'warning', minor: 'muted' };

/** The detail view's body: the job, its reviewers, the merged findings, then the posted comment or the log so far. */
export function detailLines(job: JobRecord, ctx: TuiContext, st: Styles): string[] {
  const detail = ctx.store.detail(job);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : ctx.now;
  const took = fmtDuration(end - Date.parse(job.startedAt));
  const field = (label: string, value: string) => `  ${st.muted(label.padEnd(10))}${value}`;
  const lines = [
    `${st.bold(`${job.repo} #${job.pr}`)}  ${st.muted(job.headSha.slice(0, 8))}  ${st.badge(STATUS_TONES[job.status], job.status)}`,
    field('url', prUrl(job)),
    field('started', `${fmtTime(job.startedAt)}  ${st.muted(job.status === 'running' ? `${took} so far` : took)}`),
    field('source', [job.source, job.route && `route ${job.route}`].filter(Boolean).join(' · ')),
  ];
  if (detail.meta?.baseRef) lines.push(field('base', detail.meta.baseRef));
  if (job.error) lines.push(field('error', st.tone('danger', sanitize(job.error))));
  const score = detail.summary?.score;
  if (score) lines.push(field('score', st.tone(scoreTone(score), `${score}/5`)));

  if (detail.summary) {
    lines.push('', st.section('Reviewers'));
    const metaOf = (name: string) => detail.meta?.reviewers?.find((r: any) => r.name === name) ?? {};
    const width = Math.max(...detail.summary.reviewers.map((r) => r.name.length));
    for (const r of detail.summary.reviewers) {
      const meta = metaOf(r.name);
      const model = [meta.model ?? 'default model', meta.effort && `effort ${meta.effort}`].filter(Boolean).join(', ');
      const result = r.ok
        ? st.tone(scoreTone(r.score ?? 1), `${r.score}/5`)
        : st.tone('danger', `failed: ${sanitize(r.error ?? 'unknown error')}`);
      lines.push(
        `  ${st.key(r.name.padEnd(width))}  ${result}  ${st.muted(`${fmtDuration(r.durationMs)} · ${model}`)}`,
      );
    }
  }

  if (detail.findings.length) {
    lines.push('', st.section(`Findings (${detail.findings.length})`));
    for (const f of detail.findings) {
      const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : 'general';
      lines.push(
        `  ${st.tone(SEVERITY_TONES[f.severity] ?? 'muted', f.severity.padEnd(8))} ${st.bold(sanitize(f.title))}  ${st.muted(where)}`,
        `           ${st.muted(sanitize(f.detail).replace(/\s+/g, ' '))}`,
        `           ${st.muted(`by ${f.reviewers.join(', ')}`)}`,
      );
    }
  }

  if (detail.comment.length) {
    lines.push('', st.section('Comment'), ...detail.comment.map((l) => `  ${l}`));
  } else if (job.status === 'running' || job.status === 'failed') {
    const log = ctx.store.log(job);
    lines.push(
      '',
      st.section('Log'),
      ...(log.length ? log.map((l) => `  ${l}`) : [`  ${st.muted('nothing logged yet')}`]),
    );
  } else if (job.status === 'skipped') {
    lines.push('', st.muted('  a skip route matched, so no reviewer ran'));
  }
  return lines;
}

const HELP_LINES: [string, string][] = [
  ['↑↓ j k', 'move · g/G top and bottom · pgup/pgdn page'],
  ['enter', 'open the job: scores, findings, and the posted comment'],
  ['n p', 'next and previous job while viewing one'],
  ['l', "the job's lines from the daemon log, following as they arrive"],
  ['L', 'the whole daemon log'],
  ['r', 'review the PR again (asks first); runs in the background and logs to daemon.log'],
  ['o', 'open the PR in the browser'],
  ['y', "copy the PR's URL to the clipboard"],
  ['/', 'filter by repo, PR, commit, status, source, route, or error text'],
  ['s', 'cycle the status filter: running, done, failed, skipped, all'],
  ['esc', 'back; on the list it clears the filters, then quits'],
  ['q', 'quit'],
];

function daemonLine(ctx: TuiContext, st: Styles): string {
  const d = ctx.daemon;
  if (!d) return st.muted('daemon …');
  if (!d.running) return `${st.badge('danger', 'daemon stopped')}  ${st.muted('start it with review-relay start -d')}`;
  const up = d.uptimeMs === null ? '' : ` · up ${fmtDuration(d.uptimeMs)}`;
  const forwarders = d.forwarders.length
    ? ` · ${d.forwarders.filter((f) => f.alive).length}/${d.forwarders.length} forwarders`
    : '';
  return `${st.badge('success', 'daemon running')}  ${st.muted(`pid ${d.pid}${up}${forwarders}`)}`;
}

function hint(state: TuiState, list: JobRecord[]): string {
  if (state.confirm) return 'y re-run · any other key cancels';
  if (state.filtering) return 'type to filter · ↑↓ move · enter keep filter · esc clear it';
  switch (state.view) {
    case 'help':
      return 'any key closes help';
    case 'detail':
      return '↑↓ scroll · n/p next/prev · l log · r re-run · o open PR · y copy url · esc back';
    case 'log':
      return `↑↓ scroll · G follow · L ${state.wholeLog ? 'this job only' : 'whole log'} · esc back`;
    default: {
      const back = state.filter || state.status ? 'esc clear filter' : 'q quit';
      const job = list.length ? 'enter open · l log · r re-run · o open PR · y copy url · ' : '';
      return `↑↓ move · ${job}/ filter · s status · ? help · ${back}`;
    }
  }
}

/** Draws the current view as `height` lines; the loop clips them to the terminal's width. */
export function renderTui(state: TuiState, ctx: TuiContext, st: Styles, version: string): string[] {
  const jobs = ctx.store.jobs;
  const list = visible(state, jobs);
  const cursor = cursorOf(state, list);
  const job = list[cursor];
  const counts = STATUSES.map((s) => [s, jobs.filter((j) => j.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => st.tone(STATUS_TONES[s], `${n} ${s}`));
  const summary = jobs.length
    ? [`${jobs.length} jobs`, ...counts].join(st.muted(' · '))
    : st.muted('no review jobs yet');
  const narrowed = state.status || state.filter ? st.muted(`  showing ${list.length}`) : '';
  const filterText = state.filtering
    ? `${st.tone('info', '/')} ${state.filter ?? ''}▏`
    : state.filter
      ? st.muted(`/ ${state.filter}`)
      : '';
  const statusText = state.status ? st.tone(STATUS_TONES[state.status], `[${state.status}]`) : '';
  const head = [
    `${st.title('review-relay')} ${st.muted(`v${version}`)}  ${daemonLine(ctx, st)}`,
    `${summary}${narrowed}  ${[statusText, filterText].filter(Boolean).join(' ')}`.trimEnd(),
    '',
  ];
  const live = state.flash && state.flash.until > ctx.now ? state.flash : undefined;
  const notice = state.confirm
    ? `${st.badge('warning', `review ${job?.repo} #${job?.pr} again with the configured reviewers?`)}`
    : live
      ? st.badge(live.tone, live.text)
      : undefined;
  const foot = ['', ...(notice ? [notice] : []), st.muted(hint(state, list))];
  const bodyRoom = Math.max(1, ctx.height - head.length - foot.length);
  const paint = st.paint;
  const paintCode = (code: string, text: string) => paint(`\x1b[${code}m`, text);

  let body: string[];
  if (state.view === 'help') {
    const width = Math.max(...HELP_LINES.map(([k]) => k.length));
    body = [st.section('Keys'), ...HELP_LINES.map(([k, what]) => `  ${st.key(k.padEnd(width))}  ${what}`)];
  } else if (state.view === 'detail' && job) {
    const lines = detailLines(job, ctx, st);
    const top = Math.min(state.scroll, Math.max(0, lines.length - bodyRoom));
    body = lines.slice(top, top + bodyRoom);
  } else if (state.view === 'log') {
    const lines = ctx.store.log(state.wholeLog ? undefined : job);
    const title = state.wholeLog ? tildify(logFilePath(ctx.store.dataDir)) : job ? `${job.repo} #${job.pr}` : 'log';
    const shown = lines.length ? lines : [st.muted(state.wholeLog ? 'no log yet' : 'nothing logged for this job yet')];
    const avail = bodyRoom - 1;
    const max = Math.max(0, shown.length - avail);
    const top = state.follow ? max : Math.min(state.scroll, max);
    const range =
      shown.length > avail
        ? st.muted(`  lines ${top + 1}-${Math.min(shown.length, top + avail)} of ${shown.length}`)
        : '';
    body = [
      `${st.section(`Log · ${title}`)}${range}${state.follow ? st.muted('  following') : ''}`,
      ...shown.slice(top, top + avail),
    ];
  } else if (list.length === 0) {
    body = [
      st.muted(
        jobs.length === 0
          ? 'Jobs appear here as the daemon reviews PRs, or run one with: review-relay run --repo owner/name --pr N'
          : 'no job matches the filter',
      ),
    ];
  } else {
    const table = renderStatus(list, {
      dataDir: ctx.store.dataDir,
      reviewers: ctx.reviewers,
      color: st.color,
      now: ctx.now,
      reports: list.map((j) => ctx.store.report(j)),
    });
    const [header, ...rows] = table;
    const marked = rows.map((row, i) => `${i === cursor ? st.tone('info', '›') : ' '} ${row}`);
    body = [`  ${header}`, ...windowed(marked, cursor, bodyRoom - 1, paintCode)];
  }
  return [...head, ...body, ...Array(Math.max(0, bodyRoom - body.length)).fill(''), ...foot].map((l) =>
    l ? ` ${l}` : l,
  );
}

/** Opens `url` with the platform's opener; WSL goes through `wslview` when it is installed. */
function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : [Bun.which('wslview') ? 'wslview' : 'xdg-open', url];
  const child = spawn(opener[0]!, opener.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Performs `effect` and says what happened, for the flash line. */
export function perform(effect: Effect, config: Config, configPath: string): { text: string; tone: Tone } {
  switch (effect.kind) {
    case 'rerun': {
      const { job } = effect;
      const pid = spawnDetached(config.dataDir, [
        'run',
        '--config',
        configPath,
        '--repo',
        job.repo,
        '--pr',
        String(job.pr),
      ]);
      return {
        text: `re-reviewing ${job.repo} #${job.pr} in the background (pid ${pid}); press l to follow`,
        tone: 'success',
      };
    }
    case 'open':
      openInBrowser(effect.url);
      return { text: `opening ${effect.url}`, tone: 'info' };
    case 'copy':
      // OSC 52 asks the terminal itself to set the clipboard, so it works over SSH and needs no clipboard tool.
      process.stdout.write(`\x1b]52;c;${Buffer.from(effect.text).toString('base64')}\x07`);
      return { text: `copied ${effect.text}`, tone: 'success' };
  }
}

/** How often the daemon record is re-inspected, in ticks of one second. */
const DAEMON_EVERY = 5;

export async function tui(config: Config, configPath: string, version: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('tui needs an interactive terminal');
  const st = styles(true);
  const store = new JobStore(config.dataDir);
  store.refresh();
  let daemon: DaemonState | null = await inspectDaemon(config.dataDir, config.port);
  let state = initialState();
  let ticks = 0;
  const ctx = (height: number, width: number): TuiContext => ({
    store,
    daemon,
    reviewers: config.reviewers,
    now: Date.now(),
    height,
    width,
  });
  const size = () => [process.stdout.rows || 24, process.stdout.columns || 80] as const;
  await runScreen({
    tickMs: 1000,
    tick: () => {
      store.refresh();
      if (++ticks % DAEMON_EVERY === 0) {
        void inspectDaemon(config.dataDir, config.port).then((d) => (daemon = d));
      }
    },
    render: (height, width) => renderTui(state, ctx(height, width), st, version),
    key: (key) => {
      const [height, width] = size();
      state = reduce(state, key, ctx(height, width));
      if (state.effect) {
        let result: { text: string; tone: Tone };
        try {
          result = perform(state.effect, config, configPath);
        } catch (err) {
          result = { text: err instanceof Error ? err.message : String(err), tone: 'danger' };
        }
        state = { ...state, effect: undefined, flash: { ...result, until: Date.now() + FLASH_MS } };
      }
      return !!state.done;
    },
  });
}
