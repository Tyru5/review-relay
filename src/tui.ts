/**
 * `review-relay tui`: a live terminal view of the review jobs. It reads what the daemon writes (`state.json`, the
 * report folders, `daemon.log`) and polls for changes, since the daemon exposes no query API. From the list a job
 * opens into its scores, findings, and the posted comment, or into its log lines; a PR can be re-reviewed, opened in
 * the browser, or have its URL copied, and a queued or running review cancelled.
 *
 * Like `setup`, the screen is a pure state machine: `reduce` applies a key, `renderTui` draws, and side effects
 * (spawning a run, opening a browser) come back as an `effect` the loop performs.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pricesFor, THEMES, type Config, type ThemeName } from './config.ts';
import { inspectDaemon, logFilePath, readLast, spawnDetached, type DaemonState } from './daemon.ts';
import { prState, type PrState } from './github.ts';
import { renderMarkdownView, wrapSpans, type MarkdownDetails } from './markdown.ts';
import { sumTotals } from './cost.ts';
import { reportDirFor } from './report.ts';
import { localTag } from './local.ts';
import { activeJob, jobTarget, orphaned, shownStatus, StateStore, type JobRecord, type JobStatus } from './state.ts';
import { readReport, renderStatus, type ReportSummary } from './status.ts';
import { clip, colorDepth, fill, moved, pan, rgb, runScreen, windowed } from './term.ts';
import {
  ANSI,
  fmtDuration,
  sanitize,
  styles,
  supportsColor,
  tildify,
  visibleLength,
  type Styles,
  type Tone,
} from './ui.ts';
import { isLocal } from './types.ts';
import { DEFAULT_PRICES, fmtCost, fmtUsage, type Price } from './usage.ts';
import { mergeFindings, type Finding, type MergedFinding, type Verdict } from './verdict.ts';

const STATUSES: JobStatus[] = ['queued', 'running', 'done', 'failed', 'skipped', 'superseded', 'cancelled'];
const STATUS_TONES: Record<JobStatus | 'cancelling', Tone> = {
  queued: 'muted',
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'info',
  superseded: 'muted',
  cancelled: 'muted',
  cancelling: 'warning',
};
/** Log lines kept per job view; the file itself is read from the end. */
const LOG_LINES = 300;
const FLASH_MS = 4000;

export const prUrl = (job: { repo: string; pr: number }) => `https://github.com/${job.repo}/pull/${job.pr}`;

/** The job's repo and what it reviewed: `owner/name #12`, or `owner/name feat` for a local review. */
const jobTitle = (job: JobRecord) => `${job.repo} ${jobTarget(job)}`;

/** A job queued or running when its process is gone, as a failure, the way `StateStore` loads it. */
const settled = (job: JobRecord): JobRecord =>
  orphaned(job, false) ? { ...job, status: 'failed', error: job.error ?? 'stopped before finishing' } : job;

/**
 * The jobs in `state.json` as they are on disk. Unlike `StateStore`, this keeps a `running` record without a pid as
 * running (the store rewrites those as failed for crash recovery), since the TUI shows in-flight reviews. A record
 * whose process is gone shows as failed.
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
    .map(settled)
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

const isFinished = (job: JobRecord) => !activeJob(job);

/** Why a job can't be cancelled. */
const notActiveText = (job: JobRecord) => `${jobTitle(job)} is not queued or running, so there is nothing to cancel`;

/** Why a queued or running job can't be re-reviewed yet. */
const busyText = (job: JobRecord) =>
  `${jobTitle(job)} ${job.status === 'queued' ? 'is queued for review' : 'is being reviewed now'}`;

/**
 * The cache key for a job's report folder reads. A re-run reuses the job's key (`repo@sha`) but starts again, moves
 * back to `running`, and ends with a new `finishedAt`, so the run's identity is part of the key and a stale read
 * can't survive a re-run.
 */
const cacheKey = (job: JobRecord) =>
  [job.key, job.status, job.startedAt, job.finishedAt ?? '', job.reportDir ?? ''].join('|');

/** What the TUI reads from the data folder, cached where a job can no longer change. */
export class JobStore {
  jobs: JobRecord[] = [];
  private seen = '';
  private readonly reports = new Map<string, ReportSummary | null>();
  private readonly details = new Map<string, JobDetail>();
  private readonly prs = new Map<string, { state: PrState | 'unknown'; checkedAt: number }>();
  private refreshingPrs = false;

  constructor(
    readonly dataDir: string,
    private readonly fetchPrState = prState,
    /** Prices for usage recorded without a cost. */
    private readonly prices: Record<string, Price> = DEFAULT_PRICES,
  ) {}

  /** PR state belongs to the PR, not a particular review or commit. Local reviews have none. */
  prState(job: JobRecord): PrState | 'unknown' | undefined {
    return isLocal(job) ? undefined : (this.prs.get(prUrl(job))?.state ?? 'unknown');
  }

  /** Refresh nearby PRs at most once a minute, four at a time. A merged PR cannot reopen. */
  async refreshPrStates(jobs: JobRecord[], now = Date.now(), signal?: AbortSignal): Promise<void> {
    if (this.refreshingPrs) return;
    const unique = new Map(jobs.filter((job) => !isLocal(job)).map((job) => [prUrl(job), job]));
    const pending = [...unique].filter(([key]) => {
      const cached = this.prs.get(key);
      return !cached || (cached.state !== 'merged' && now - cached.checkedAt >= 60_000);
    });
    this.refreshingPrs = true;
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          for (;;) {
            if (signal?.aborted) return;
            const next = pending.shift();
            if (!next) return;
            const [key, job] = next;
            let state: PrState | 'unknown' = 'unknown';
            try {
              state = await this.fetchPrState(job.repo, job.pr, signal);
            } catch {
              // Offline, missing gh/auth, or inaccessible PR: never imply that it is open or merged.
            }
            this.prs.set(key, { state, checkedAt: now });
          }
        }),
      );
    } finally {
      this.refreshingPrs = false;
    }
  }

  /**
   * Re-reads `state.json` when its size or mtime changed; returns true when the list was reloaded. Cache entries
   * for jobs that are gone or have changed are dropped.
   */
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
    const live = new Set(this.jobs.map(cacheKey));
    for (const cache of [this.reports, this.details]) {
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    }
    return true;
  }

  private dirOf(job: JobRecord) {
    return job.reportDir ?? reportDirFor(this.dataDir, job);
  }

  /** Scores and finding counts; null while running or when the job never got a report. */
  report(job: JobRecord): ReportSummary | null {
    if (!isFinished(job)) return null;
    const key = cacheKey(job);
    if (!this.reports.has(key)) this.reports.set(key, readReport(this.dirOf(job), this.prices));
    return this.reports.get(key)!;
  }

  detail(job: JobRecord): JobDetail {
    const key = cacheKey(job);
    const cached = this.details.get(key);
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
    if (isFinished(job)) this.details.set(key, detail);
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
    if (job && isLocal(job)) {
      const tag = localTag(job);
      lines = lines.filter((l) => l.includes(tag)).slice(-LOG_LINES);
    } else if (job) {
      const tag = `[${job.repo}]`;
      // A digit boundary, so PR #12's view doesn't pick up PR #120.
      const pr = new RegExp(`PR #${job.pr}(?!\\d)`);
      lines = lines.filter((l) => l.includes(tag) && (pr.test(l) || l.includes(job.key))).slice(-LOG_LINES);
    }
    return lines.map(sanitize);
  }
}

export type View = 'list' | 'detail' | 'log' | 'help';

export type Effect =
  | { kind: 'rerun'; job: JobRecord }
  | { kind: 'cancel'; job: JobRecord }
  | { kind: 'open'; url: string }
  | { kind: 'copy'; text: string }
  | { kind: 'theme'; theme: ThemeName };

const NO_PR = 'a local review has no PR; open one from the branch first';

export interface TuiState {
  view: View;
  theme: ThemeName;
  /** Key of the highlighted job, so the cursor follows it as the list changes; the top job when unset or gone. */
  selected?: string;
  /** Text narrowing the list to jobs whose row contains it. */
  filter?: string;
  filtering: boolean;
  /** Only jobs with this status are listed. */
  status?: JobStatus;
  /** Top line shown in the detail, log, and help views. */
  scroll: number;
  /** Columns panned sideways in the current view, when its rows are wider than the panel; reset on a view change. */
  hscroll: number;
  /** Disclosure state belongs to one review run, not another job or a later re-run. */
  details?: MarkdownDetails & { job: string };
  /** The log view shows the whole daemon log instead of the selected job's lines. */
  wholeLog: boolean;
  /** The log view keeps its end in view as lines arrive. */
  follow: boolean;
  /** A pending question, bound to the job it was asked about, so a list change can't retarget the answer. */
  confirm?: { action: 'rerun' | 'cancel'; key: string };
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

export const initialState = (theme: ThemeName = 'dark'): TuiState => ({
  view: 'list',
  theme,
  filtering: false,
  scroll: 0,
  hscroll: 0,
  wholeLog: false,
  follow: true,
});

const rowText = (job: JobRecord) =>
  [job.status, job.repo, jobTarget(job), job.headSha, job.source, job.route ?? '', job.error ?? '']
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

/** Rows outside the body's panel: header, status, footer, and the panel's two borders; the message rows come on top. */
const CHROME = 5;
/** The most rows a long message takes before it is cut short. */
const MESSAGE_ROWS = 3;
/** The share of the body the job table takes on the list view when the detail pane fits under it. */
const LIST_SHARE = 0.8;
/** The fewest rows the detail pane under the table takes, borders included; with less it is dropped. */
const DETAIL_MIN = 8;
/** Lines a full-body panel shows, after the message takes its rows. */
const room = (state: TuiState, ctx: TuiContext) =>
  Math.max(1, ctx.height - CHROME - messageLines(state, ctx, styles(false)).length);
/** Columns a panel's rows have: the width less the border and padding on each side. */
const innerWidth = (ctx: TuiContext) => Math.max(1, ctx.width - 4);
/** Columns a job row has: the panel's, less the cursor marker. */
const rowWidth = (ctx: TuiContext) => Math.max(1, innerWidth(ctx) - 2);

const widthOf = (lines: string[]) => Math.max(0, ...lines.map(visibleLength));

/** `text` as plain lines no wider than `width`, each starting with `indent`; the caller styles them. */
const wrapped = (text: string, width: number, indent: string) =>
  wrapSpans([{ text }], width, styles(false), indent, indent);

/**
 * Pans the view sideways by half the panel for an arrow, stopping at the edges. The arrows only ever pan: held past an
 * edge, they must not open, switch, or leave a job.
 */
function panned(state: TuiState, key: 'left' | 'right', widest: number, inner: number): TuiState {
  const max = Math.max(0, widest - inner);
  const at = Math.min(state.hscroll, max);
  const step = Math.max(8, Math.floor(inner / 2));
  return { ...state, hscroll: key === 'right' ? Math.min(max, at + step) : Math.max(0, at - step) };
}

/** The widest row of the current view and the columns it has, for panning; nothing pans in the help view. */
function extent(state: TuiState, ctx: TuiContext): { widest: number; inner: number } {
  const st = styles(false);
  switch (state.view) {
    case 'list':
      return { widest: widthOf(listRows(state, ctx, st)), inner: rowWidth(ctx) };
    case 'detail': {
      const job = selectedJob(state, ctx);
      return { widest: job ? widthOf(detailContent(job, ctx, st, state.details).lines) : 0, inner: innerWidth(ctx) };
    }
    case 'log':
      return {
        widest: widthOf(ctx.store.log(state.wholeLog ? undefined : selectedJob(state, ctx))),
        inner: innerWidth(ctx),
      };
    default:
      return { widest: 0, inner: innerWidth(ctx) };
  }
}

/** Keys that act on the highlighted job from the list and detail views. */
function jobKeys(state: TuiState, key: string, ctx: TuiContext): TuiState | undefined {
  const job = selectedJob(state, ctx);
  if (!job) return undefined;
  // Acting on the top job pins the selection to it, so a job arriving above can't change what the action means.
  const pinned = { ...state, selected: job.key };
  switch (key) {
    case 'r':
      if (activeJob(job)) return flash(pinned, busyText(job), ctx, 'warning');
      return { ...pinned, confirm: { action: 'rerun', key: job.key } };
    case 'c':
      if (!activeJob(job)) return flash(pinned, notActiveText(job), ctx, 'warning');
      if (job.cancelRequested) return flash(pinned, `${jobTitle(job)} is already being cancelled`, ctx, 'muted');
      return { ...pinned, confirm: { action: 'cancel', key: job.key } };
    case 'o':
      if (isLocal(job)) return flash(pinned, NO_PR, ctx, 'warning');
      return { ...pinned, effect: { kind: 'open', url: prUrl(job) } };
    case 'y':
      if (isLocal(job)) return flash(pinned, NO_PR, ctx, 'warning');
      return { ...pinned, effect: { kind: 'copy', text: prUrl(job) } };
    case 'l':
      return { ...pinned, view: 'log', wholeLog: false, follow: true, scroll: 0 };
    case 'L':
      return { ...pinned, view: 'log', wholeLog: true, follow: true, scroll: 0 };
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
  const at = moved(cursorOf(state, list), key, list.length, Math.max(1, room(state, ctx) - 2));
  return at === undefined ? undefined : { ...state, selected: list[at]!.key };
}

/** Applies one key. Sets `done` to quit and `effect` for the loop to perform. A new view starts unpanned. */
export function reduce(state: TuiState, key: string, ctx: TuiContext): TuiState {
  const next = reduceKey(state, key, ctx);
  return next.view === state.view ? next : { ...next, hscroll: 0 };
}

function reduceKey(state: TuiState, key: string, ctx: TuiContext): TuiState {
  if (key === 'ctrl-c') return { ...state, done: true };
  const base: TuiState = { ...state, effect: undefined };
  if (state.confirm) {
    const { action } = state.confirm;
    const next = { ...base, confirm: undefined };
    if (key !== 'y') return flash(next, action === 'cancel' ? 'left it running' : 'cancelled', ctx, 'muted');
    // The job as it is now, not as it was when asked: it may have gone, or a review of it may have started or ended.
    const job = ctx.store.jobs.find((j) => j.key === state.confirm!.key);
    if (!job) return flash(next, 'that job is no longer listed', ctx, 'warning');
    if (action === 'cancel') {
      if (!activeJob(job)) return flash(next, `${jobTitle(job)} already finished`, ctx, 'warning');
      return { ...next, effect: { kind: 'cancel', job } };
    }
    if (activeJob(job)) return flash(next, busyText(job), ctx, 'warning');
    return { ...next, effect: { kind: 'rerun', job } };
  }
  if (state.view === 'help') {
    // Scroll keys scroll the help, even when it fits; any other key closes it.
    return scrolled(base, key, helpLines(ctx, styles(false)).length, room(base, ctx)) ?? { ...base, view: 'list' };
  }
  if (key === 'left' || key === 'right') {
    const { widest, inner } = extent(state, ctx);
    return panned(base, key, widest, inner);
  }
  if (state.filtering) return filtered(base, key, ctx);
  if (key === 't') {
    const theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]!;
    return { ...base, theme, effect: { kind: 'theme', theme } };
  }
  // The header's tabs: a digit picks one, tab moves to the other.
  const onLog = state.view === 'log';
  if (key === '1' || (key === 'tab' && onLog)) return onLog ? { ...base, view: 'list' } : base;
  if (key === '2' || (key === 'tab' && !onLog)) {
    const job = selectedJob(state, ctx);
    return onLog ? base : { ...base, selected: job?.key ?? state.selected, view: 'log', follow: true, scroll: 0 };
  }

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
        return list.length
          ? { ...base, selected: list[cursorOf(state, list)]!.key, view: 'detail', scroll: 0, details: undefined }
          : base;
      case '?':
        return { ...base, view: 'help', scroll: 0 };
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
    const content = job ? detailContent(job, ctx, styles(false), state.details) : { lines: [], sections: [] };
    if (job && content.sections.length && ['[', ']', 'enter', 'space'].includes(key)) {
      const details = state.details?.job === cacheKey(job) ? state.details : { job: cacheKey(job) };
      const sections = content.sections;
      const at = sections.findIndex((s) => s.id === details.selected);
      const fromScroll = sections.findIndex((s) => s.line >= state.scroll);
      const toggle = key === 'enter' || key === 'space';
      const index =
        at < 0
          ? key === '[' || fromScroll < 0
            ? sections.length - 1
            : fromScroll
          : toggle
            ? at
            : (at + (key === ']' ? 1 : -1) + sections.length) % sections.length;
      const section = sections[index]!;
      let open = details.open ?? [];
      if (toggle) open = open.includes(section.id) ? open.filter((id) => id !== section.id) : [...open, section.id];
      const next = { ...base, details: { ...details, selected: section.id, open } };
      const updated = detailContent(job, ctx, styles(false), next.details);
      // Put the selected header near the top so its body is visible after expansion.
      return { ...next, scroll: Math.max(0, Math.min(section.line - 1, updated.lines.length - room(next, ctx))) };
    }
    const scroll = scrolled(base, key, content.lines.length, room(base, ctx));
    if (scroll) return scroll;
    const list = visible(state, ctx.store.jobs);
    const at = cursorOf(state, list);
    switch (key) {
      case 'n':
        return at < list.length - 1 ? { ...base, selected: list[at + 1]!.key, scroll: 0, details: undefined } : base;
      case 'p':
        return at > 0 ? { ...base, selected: list[at - 1]!.key, scroll: 0, details: undefined } : base;
      case 'escape':
      case 'q':
      case 'backspace':
        return { ...base, view: 'list' };
      case '?':
        return { ...base, view: 'help', scroll: 0 };
      default:
        return jobKeys(base, key, ctx) ?? base;
    }
  }

  // Log view.
  const lines = ctx.store.log(state.wholeLog ? undefined : selectedJob(state, ctx));
  const scroll = scrolled(base, key, lines.length, room(base, ctx));
  if (scroll) return scroll;
  switch (key) {
    case 'L':
      return { ...base, wholeLog: !state.wholeLog, follow: true, scroll: 0 };
    case 'escape':
    case 'q':
    case 'backspace':
      return { ...base, view: 'list' };
    case '?':
      return { ...base, view: 'help', scroll: 0 };
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
function detailContent(job: JobRecord, ctx: TuiContext, st: Styles, details?: TuiState['details']) {
  const detail = ctx.store.detail(job);
  const pr = ctx.store.prState(job);
  const prBadge = pr
    ? `  ${st.badge(pr === 'merged' ? 'info' : pr === 'open' ? 'success' : pr === 'closed' ? 'danger' : 'muted', `PR ${pr}`)}`
    : '';
  let sections: { id: number; line: number }[] = [];
  const end = job.finishedAt ? Date.parse(job.finishedAt) : ctx.now;
  const took = fmtDuration(end - Date.parse(job.startedAt));
  const field = (label: string, value: string) => `  ${st.muted(label.padEnd(10))}${value}`;
  const lines = [
    `${st.bold(jobTitle(job))}  ${st.muted(job.headSha.slice(0, 8))}  ${st.badge(STATUS_TONES[shownStatus(job)], shownStatus(job))}${prBadge}`,
    ...(isLocal(job)
      ? [field('branch', `${job.branch} against ${job.base}`), field('checkout', tildify(job.localPath ?? ''))]
      : [field('url', prUrl(job))]),
    field('started', `${fmtTime(job.startedAt)}  ${st.muted(activeJob(job) ? `${took} so far` : took)}`),
    field('source', [job.source, job.route && `route ${job.route}`].filter(Boolean).join(' · ')),
  ];
  if (detail.meta?.baseRef && !isLocal(job)) lines.push(field('base', detail.meta.baseRef));
  if (job.error) lines.push(field('error', st.tone('danger', sanitize(job.error))));
  const score = detail.summary?.score;
  if (score) lines.push(field('score', st.tone(scoreTone(score), `${score}/5`)));
  const cost = detail.summary?.cost;
  if (cost) {
    const each = detail.summary!.reviewers.map(
      (r) =>
        `${r.name} ${r.usage?.costUsd === undefined ? '-' : fmtCost({ costUsd: r.usage.costUsd, estimated: r.usage.costSource === 'estimated' })}`,
    );
    lines.push(field('cost', `${st.bold(fmtCost(cost))}  ${st.muted(each.join(' · '))}`));
  }

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
      const spent = r.usage ? ` · ${fmtUsage(r.usage)}` : '';
      lines.push(
        `  ${st.key(r.name.padEnd(width))}  ${result}  ${st.muted(`${fmtDuration(r.durationMs)} · ${model}${spent}`)}`,
      );
    }
  }

  if (detail.findings.length) {
    lines.push('', st.section(`Findings (${detail.findings.length})`));
    for (const f of detail.findings) {
      // Every finding field is reviewer output, paths included.
      const file = sanitize(f.file ?? '');
      const where = file ? (f.line ? `${file}:${f.line}` : file) : 'general';
      const indent = ' '.repeat(11);
      lines.push(
        `  ${st.tone(SEVERITY_TONES[f.severity] ?? 'muted', f.severity.padEnd(8))} ${st.bold(sanitize(f.title))}  ${st.muted(where)}`,
        ...wrapped(sanitize(f.detail).replace(/\s+/g, ' '), innerWidth(ctx), indent).map((l) => st.muted(l)),
        `${indent}${st.muted(`by ${f.reviewers.join(', ')}`)}`,
      );
    }
  }

  if (job.status === 'superseded') {
    const head = job.supersededBy ? ` (${job.supersededBy.slice(0, 8)})` : '';
    lines.push('', st.muted(`  the PR moved to a newer commit${head} first, so nothing was posted`));
  }
  if (job.status === 'cancelled') lines.push('', st.muted('  cancelled before it finished, so nothing was posted'));
  if (detail.comment.length) {
    // Two for the panel's padding and border on each side, two for the section indent.
    const width = Math.max(20, ctx.width - 6);
    const heading = isLocal(job) ? 'Review' : job.status === 'superseded' ? 'Comment (not posted)' : 'Comment';
    const comment = renderMarkdownView(
      detail.comment.join('\n'),
      width,
      st,
      // Sections start collapsed, like the posted comment on GitHub.
      { open: [], ...(details?.job === cacheKey(job) ? details : {}) },
    );
    lines.push('', st.section(heading));
    sections = comment.sections.map((s) => ({ ...s, line: s.line + lines.length }));
    lines.push(...comment.lines.map((l) => `  ${l}`));
  } else if (activeJob(job) || job.status === 'failed' || job.status === 'cancelled') {
    const log = ctx.store.log(job);
    lines.push(
      '',
      st.section('Log'),
      ...(log.length ? log.map((l) => `  ${l}`) : [`  ${st.muted('nothing logged yet')}`]),
    );
  } else if (job.status === 'skipped') {
    lines.push('', st.muted('  a skip route matched, so no reviewer ran'));
  }
  return { lines, sections };
}

/** The message row's text: a pending question (with a shorter form for narrow terminals) or a live flash. */
function message(state: TuiState, ctx: TuiContext): { text: string; short?: string; tone: Tone } | undefined {
  const asked = state.confirm && ctx.store.jobs.find((j) => j.key === state.confirm!.key);
  if (asked && state.confirm!.action === 'cancel') {
    return {
      text: `cancel the review of ${jobTitle(asked)}? its reviewers stop and nothing is posted`,
      short: `cancel ${jobTitle(asked)}?`,
      tone: 'warning',
    };
  }
  if (asked) {
    return {
      text: `review ${jobTitle(asked)} again with the configured reviewers?`,
      short: `review ${jobTitle(asked)} again?`,
      tone: 'warning',
    };
  }
  const live = state.flash && state.flash.until > ctx.now ? state.flash : undefined;
  return live && { text: live.text, tone: live.tone };
}

/**
 * The message as rows: one blank row with no message, one when it fits, else the short form or the text wrapped
 * onto up to `MESSAGE_ROWS` rows, the last ending in an ellipsis. Errors surface only here, so they are not cut.
 */
function messageLines(state: TuiState, ctx: TuiContext, st: Styles): string[] {
  const m = message(state, ctx);
  if (!m) return [''];
  // The row is a space, the badge's icon, a space, then the text.
  const width = Math.max(1, ctx.width - 3);
  const text = visibleLength(m.text) <= width || !m.short ? m.text : m.short;
  // A path or URL wider than the row has no space to wrap at, so it is broken at the row's edge instead of cut. The
  // chunks are plain text, and `clip` counts code points, so the bound does too (an emoji is one column, two units).
  let chunks = wrapped(text, width, '').flatMap((chunk) => {
    const pieces: string[] = [];
    const columns = [...chunk].length;
    for (let at = 0; at === 0 || at < columns; at += width) pieces.push(clip(chunk, width, at));
    return pieces;
  });
  if (chunks.length > MESSAGE_ROWS) {
    chunks = [...chunks.slice(0, MESSAGE_ROWS - 1), `${clip(chunks[MESSAGE_ROWS - 1]!, width - 1)}…`];
  }
  return chunks.map((chunk, i) => (i === 0 ? ` ${st.badge(m.tone, chunk)}` : `   ${st.tone(m.tone, chunk)}`));
}

/** The `?` key help. test/docs.test.ts checks the site's key table against it. */
export const HELP_LINES: [string, string][] = [
  ['↑↓ j k', 'move · g/G top and bottom · pgup/pgdn page'],
  [
    '← →',
    'pan a table or line that is wider than the screen; they only pan, so enter opens a job, n/p move between jobs, and esc goes back',
  ],
  ['enter', 'open the job: scores, findings, and the posted comment'],
  ['[ ]', 'previous/next Details or Dimension notes section in the comment'],
  ['enter space', 'expand/collapse the selected section while viewing a job'],
  ['n p', 'next and previous job while viewing one'],
  ['l', "the job's lines from the daemon log, following as they arrive"],
  ['L', 'the whole daemon log'],
  ['1 2 tab', 'switch between the Jobs and Log tabs'],
  ['t', 'cycle theme: dark, light, terminal (syncs terminal colors); saves to config'],
  ['r', 'review the PR or local branch again (asks first); runs in the background and logs to daemon.log'],
  ['c', 'cancel a queued or running review (asks first); its reviewers stop and nothing is posted'],
  ['o', 'open the PR in the browser'],
  ['y', "copy the PR's URL to the clipboard"],
  ['/', 'filter by repo, PR, commit, status, source, route, or error text'],
  ['s', 'cycle the status filter: queued, running, done, failed, skipped, superseded, cancelled, all'],
  ['esc', 'back; on the list it clears the filters, then quits'],
  ['q', 'quit'],
];

/** The key help, each description wrapped to the panel so nothing is cut off on a narrow screen. */
function helpLines(ctx: TuiContext, st: Styles): string[] {
  const w = Math.max(...HELP_LINES.map(([k]) => k.length));
  return HELP_LINES.flatMap(([k, what]) => {
    const [first, ...rest] = wrapped(what, innerWidth(ctx), ' '.repeat(w + 2));
    return [`${st.key(k.padEnd(w))}  ${first!.trimStart()}`, ...rest];
  });
}

/** The first of `candidates` that fits in `width` columns, else the last (the shortest) one, for responsive rows. */
const fitting = (width: number, ...candidates: string[]) =>
  candidates.find((c) => visibleLength(c) <= width) ?? candidates.at(-1)!;

/** `← 20 more · 48 more →`: the columns hidden on each side of a panned panel, for its border. */
const panNote = (hscroll: number, widest: number, inner: number) =>
  [hscroll > 0 && `← ${hscroll} more`, widest - inner - hscroll > 0 && `${widest - inner - hscroll} more →`]
    .filter(Boolean)
    .join(' · ');

/** The Model Router palette, so this TUI looks like the user's other terminal tools. */
const PALETTE = {
  bg: 0x0d1421,
  panel: 0x131d2d,
  fg: 0xdee7f2,
  muted: 0x8da0b4,
  accent: 0x4fd1c5,
  line: 0x2e4156,
  selectionBg: 0x1d3d46,
  selectionFg: 0x4fd1c5,
  success: 0x4fd1c5,
  warn: 0xf6c15b,
  red: 0xfa7e7e,
  blue: 0x73b8ff,
};
type Swatch = keyof typeof PALETTE;

const LIGHT: Record<Swatch, number> = {
  bg: 0xf3f6fa,
  panel: 0xffffff,
  fg: 0x182b3a,
  muted: 0x526579,
  accent: 0x006b63,
  line: 0x8093a5,
  selectionBg: 0xd5eee9,
  selectionFg: 0x004f49,
  success: 0x006b63,
  warn: 0x885500,
  red: 0xb32632,
  blue: 0x195fa6,
};

/** The nearest of the 16 basic colors to each swatch, for terminals without 24-bit color. */
const BASIC: Record<Swatch, string> = {
  bg: '49',
  panel: '49',
  fg: '39',
  muted: '90',
  accent: '36',
  line: '90',
  selectionBg: '7',
  selectionFg: '36',
  success: '32',
  warn: '33',
  red: '31',
  blue: '34',
};

export type ColorDepth = 'truecolor' | 'basic';

/** The shared `Styles` shape plus the palette, so the renderer never names a color code itself. */
export interface Theme extends Styles {
  /** SGR open sequence for a swatch as text color. */
  swatch(name: Swatch): string;
  /** `fill`'s base for a row painted with `bg` behind `text`; undefined when colors are off or backgrounds can't be painted. */
  base(bg: Swatch, text?: Swatch): string | undefined;
  /** SGR open sequence for the active tab pill. */
  tabOn: string;
}

/**
 * Fixed palettes use 24-bit colors when supported. Terminal mode uses ANSI palette entries and default
 * foreground/background, so it follows terminal theme changes without querying or replacing its colors.
 */
export function themeStyles(color: boolean, depth: ColorDepth = 'truecolor', theme: ThemeName = 'dark'): Theme {
  const palette = theme === 'light' ? LIGHT : PALETTE;
  const fixed = depth === 'truecolor' && theme !== 'terminal';
  const paint = (code: string, s: string) => (color && s ? `${code}${s}${ANSI.reset}` : s);
  const swatch = (name: Swatch) =>
    `\x1b[${fixed ? rgb(palette[name]) : theme === 'terminal' && (name === 'muted' || name === 'line') ? '39' : BASIC[name]}m`;
  const base = (bg: Swatch, text: Swatch = 'fg') => {
    if (!color) return undefined;
    if (fixed) return `${rgb(palette[bg], 'bg')};${rgb(palette[text])}`;
    if (theme === 'terminal') return bg === 'selectionBg' ? '39;49;7' : '39;49';
    // Basic colors can't paint a background that matches the panels; the selection shows as reverse video.
    return bg === 'selectionBg' ? '7' : undefined;
  };
  const tones: Record<Tone, string> = {
    success: swatch('success'),
    warning: swatch('warn'),
    danger: swatch('red'),
    info: swatch('blue'),
    muted: swatch('muted'),
  };
  const icons: Record<Tone, string> = { success: '✓', warning: '!', danger: '✗', info: '•', muted: '○' };
  return {
    color,
    title: (s) => paint(ANSI.bold + swatch('accent'), s),
    section: (s) => paint(swatch('accent'), s),
    key: (s) => paint(swatch('accent'), s),
    command: (s) => paint(swatch('accent'), s),
    muted: (s) => paint(swatch('muted'), s),
    bold: (s) => paint(ANSI.bold, s),
    tone: (tone, s) => paint(tones[tone], s),
    badge: (tone, label) => paint(tones[tone], `${icons[tone]} ${label}`),
    dot: (tone) => paint(tones[tone], '●'),
    paint,
    swatch,
    base,
    tabOn: fixed ? `\x1b[${rgb(palette.accent, 'bg')};${rgb(palette.bg)}m${ANSI.bold}` : `\x1b[7;39m${ANSI.bold}`,
  };
}

/** `[key] label   [key] label`, keys in the accent. */
const hints = (st: Theme, pairs: [string, string][]) =>
  pairs
    .map(([key, label]) => `${st.paint(ANSI.bold + st.swatch('accent'), `[${key}]`)} ${st.muted(label)}`)
    .join('   ');

/**
 * `hints` that fit in `width`: all of them, or the leading ones that fit, an ellipsis, and the `?` hint (or the last
 * one, where a mode has no help) so the rest stay reachable.
 */
function fitHints(st: Theme, pairs: [string, string][], width: number): string {
  const all = hints(st, pairs);
  if (visibleLength(all) <= width) return all;
  const tail = pairs.find(([key]) => key === '?') ?? pairs.at(-1)!;
  const end = `${st.muted('…')}   ${hints(st, [tail])}`;
  const head = pairs.filter((pair) => pair !== tail);
  for (let n = head.length; n > 0; n--) {
    const line = `${hints(st, head.slice(0, n))}   ${end}`;
    if (visibleLength(line) <= width) return line;
  }
  return end;
}

interface PanelOptions {
  title: string;
  /** Muted text in the top border, before the hints. */
  note?: string;
  hints?: [string, string][];
  focused?: boolean;
  /** Columns the rows are panned sideways. */
  pan?: number;
}

/** `lines` inside a rounded border, exactly `height` rows by `width` columns, with the title and hints in the top edge. */
function panel(st: Theme, width: number, height: number, lines: string[], opts: PanelOptions): string[] {
  const inner = Math.max(1, width - 4);
  const bg = st.base('panel');
  const edge = (s: string) => st.paint(st.swatch(opts.focused ? 'accent' : 'line'), s);
  // The title gives way to the corners; the note (a position) outlasts the hints, which the footer repeats.
  const title = opts.title.length > width - 7 ? `${clip(opts.title, Math.max(1, width - 8))}…` : opts.title;
  const left = `${edge('╭─')} ${st.bold(title)} `;
  const note = opts.note && st.muted(opts.note);
  const keys = opts.hints?.length && hints(st, opts.hints);
  const tails = [[note, keys], [note], [keys], []].map((parts) => parts.filter(Boolean).join('  '));
  const corner = edge('─╮');
  const space = width - visibleLength(left) - visibleLength(corner);
  const tail = tails.find((t) => !t || visibleLength(t) + 2 <= space) ?? '';
  const right = tail ? ` ${tail} ${corner}` : corner;
  const dashes = Math.max(0, width - visibleLength(left) - visibleLength(right));
  const top = fill(`${left}${edge('─'.repeat(dashes))}${right}`, width, bg);
  const rows = Array.from({ length: Math.max(0, height - 2) }, (_, i) =>
    fill(`${edge('│')} ${fill(lines[i] ?? '', inner, bg, opts.pan)} ${edge('│')}`, width, bg),
  );
  const bottom = fill(edge(`╰${'─'.repeat(Math.max(0, width - 2))}╯`), width, bg);
  return [top, ...rows, bottom];
}

function daemonLine(ctx: TuiContext, st: Styles): string {
  const d = ctx.daemon;
  if (!d) return st.muted('daemon …');
  if (!d.running) return `${st.badge('danger', 'daemon stopped')}  ${st.muted('start it with review-relay start -d')}`;
  const up = d.uptimeMs === null ? '' : ` · up ${fmtDuration(d.uptimeMs)}`;
  const standby = d.forwarders.filter((f) => f.standby).length;
  const forwarders = d.forwarders.length
    ? ` · ${d.forwarders.filter((f) => f.alive && !f.standby).length}/${d.forwarders.length} forwarders${standby ? `, ${standby} standby` : ''}`
    : '';
  return `${st.badge('success', 'daemon running')}  ${st.muted(`pid ${d.pid}${up}${forwarders}`)}`;
}

/** The footer's key hints for the current view; `wide` adds the panning hint when rows are wider than the panel. */
function footer(
  state: TuiState,
  list: JobRecord[],
  selected: JobRecord | undefined,
  wide: boolean,
): [string, string][] {
  const side: [string, string][] = wide ? [['←→', 'sideways']] : [];
  if (state.confirm)
    return state.confirm.action === 'cancel'
      ? [
          ['y', 'cancel review'],
          ['any other key', 'keep it running'],
        ]
      : [
          ['y', 're-run'],
          ['any other key', 'cancel'],
        ];
  if (state.filtering) {
    return [['type', 'to filter'], ['↑↓', 'move'], ...side, ['enter', 'keep filter'], ['esc', 'clear it']];
  }
  const job: [string, string][] = list.length
    ? [
        ['l', 'log'],
        // A queued or running job can be cancelled, not re-run.
        (selected && activeJob(selected) ? ['c', 'cancel'] : ['r', 're-run']) as [string, string],
        // A local review has no PR to open or link.
        ...(selected && isLocal(selected)
          ? []
          : ([
              ['o', 'open PR'],
              ['y', 'copy url'],
            ] as [string, string][])),
      ]
    : [];
  switch (state.view) {
    case 'help':
      return [
        ['↑↓', 'scroll'],
        ['any other key', 'closes help'],
      ];
    case 'detail':
      return [
        ['[/]', 'details'],
        ['enter', 'toggle'],
        ['↑↓', 'scroll'],
        ...side,
        ['n/p', 'next/prev'],
        ...job,
        ['esc', 'back'],
      ];
    case 'log':
      return [
        ['↑↓', 'scroll'],
        ...side,
        ['G', 'follow'],
        ['L', state.wholeLog ? 'this job only' : 'whole log'],
        ['esc', 'back'],
      ];
    default:
      return [
        ['↑↓', 'move'],
        ...side,
        ...(list.length ? ([['enter', 'open']] as [string, string][]) : []),
        ...job,
        ['/', 'filter'],
        ['s', 'status'],
        ['?', 'help'],
        state.filter || state.status ? ['esc', 'clear filter'] : ['q', 'quit'],
      ];
  }
}

/** The job table's header and rows, without the cursor margin; empty when no job is listed. */
function listRows(state: TuiState, ctx: TuiContext, st: Styles): string[] {
  const list = visible(state, ctx.store.jobs);
  if (list.length === 0) return [];
  return renderStatus(list, {
    dataDir: ctx.store.dataDir,
    reviewers: ctx.reviewers,
    color: st.color,
    styles: st,
    now: ctx.now,
    reports: list.map((j) => ctx.store.report(j)),
    prStates: list.map((j) => ctx.store.prState(j)),
  });
}

/** The smallest terminal the layout fits; below it the screen only asks for more room. */
export const MIN_SIZE = { width: 40, height: 10 };

/** Draws the current view as `height` rows of `width` columns, painted edge to edge. */
export function renderTui(state: TuiState, ctx: TuiContext, st: Theme, version: string): string[] {
  const { width, height } = ctx;
  const page = st.base('bg');
  const row = (line: string) => fill(line, width, page);
  if (width < MIN_SIZE.width || height < MIN_SIZE.height) {
    const center = (text: string) => ' '.repeat(Math.max(0, Math.floor((width - visibleLength(text)) / 2))) + text;
    const top = Math.max(0, Math.floor((height - 3) / 2));
    const lines = [
      center(st.title('REVIEW-RELAY')),
      center(`Resize to at least ${MIN_SIZE.width} × ${MIN_SIZE.height}.`),
      center(st.muted('Press q to exit.')),
    ];
    return Array.from({ length: height }, (_, i) => row(lines[i - top] ?? ''));
  }

  const jobs = ctx.store.jobs;
  const list = visible(state, jobs);
  const cursor = cursorOf(state, list);
  const job = list[cursor];

  // Header: the name, the tabs, and the data folder on the right.
  const tabs = (['Jobs', 'Log'] as const).map((name, i) => {
    const active = (state.view === 'log') === (name === 'Log');
    const label = ` ${i + 1} ${name} `;
    return active ? st.paint(st.tabOn, label) : st.muted(label);
  });
  const name = ` ${st.tone('success', '◆')} ${st.bold('REVIEW-RELAY')}  ${tabs.join(' ')}`;
  const left = `${name}  ${hints(st, [['t', state.theme]])}`;
  const right = st.muted(`${tildify(ctx.store.dataDir)} · v${version} `);
  const gap = width - visibleLength(left) - visibleLength(right);
  // Narrow terminals lose the data folder, then the theme hint (t still works).
  const header = fitting(width, gap >= 4 ? `${left}${' '.repeat(gap)}${right}` : left, left, name);

  // Status: the daemon, the counts, and the active filters.
  const counts = STATUSES.map((s) => [s, jobs.filter((j) => j.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => st.tone(STATUS_TONES[s], `${n} ${s}`));
  // Reports are cached per finished job, and the list reads them all anyway. A report without a cost marks the total
  // partial, as the cost command marks it; jobs that wrote no report (skipped, running) spent nothing to count.
  const spent = sumTotals(jobs.flatMap((j) => (ctx.store.report(j) ? [ctx.store.report(j)!.cost] : [])));
  const summary = jobs.length
    ? [`${jobs.length} jobs`, ...counts, ...(spent ? [`${fmtCost(spent)} spent`] : [])].join(st.muted(' · '))
    : st.muted('no review jobs yet');
  const narrowed = state.status || state.filter ? st.muted(`  showing ${list.length}`) : '';
  const filterText = state.filtering
    ? `${st.tone('info', '/')} ${state.filter ?? ''}▏`
    : state.filter
      ? st.muted(`/ ${state.filter}`)
      : '';
  const statusText = state.status ? st.tone(STATUS_TONES[state.status], `[${state.status}]`) : '';
  const filters = [statusText, filterText].filter(Boolean).join(' ');
  // Narrow terminals drop the daemon's details, then the counts; the filter being typed always shows.
  const daemonFull = daemonLine(ctx, st);
  const daemonShort = ctx.daemon
    ? st.badge(ctx.daemon.running ? 'success' : 'danger', ctx.daemon.running ? 'daemon running' : 'daemon stopped')
    : st.muted('daemon …');
  const brief = jobs.length ? `${jobs.length} jobs` : st.muted('no jobs');
  const statusRow = (daemon: string, count: string) =>
    ` ${daemon}  ${st.muted('│')}  ${count}${narrowed}${filters ? `  ${filters}` : ''}`;
  const status = fitting(
    width,
    statusRow(daemonFull, summary),
    statusRow(daemonShort, summary),
    statusRow(daemonShort, brief),
    ` ${daemonShort}${narrowed}${filters ? `  ${filters}` : ''}`,
  );

  // Message: a confirmation, a flash, or nothing; a long one takes its extra rows from the body.
  const messages = messageLines(state, ctx, st);

  const body = height - 3 - messages.length;
  const inner = innerWidth(ctx);
  const paintCode = (code: string, text: string) => st.paint(`\x1b[${code}m`, text);
  let panels: string[];
  /** Columns hidden on the left, after a resize may have shrunk what there is to pan. */
  let hscroll = 0;
  let overflow = 0;
  const sideways = (widest: number, columns: number) => {
    overflow = Math.max(0, widest - columns);
    hscroll = Math.min(state.hscroll, overflow);
    return panNote(hscroll, widest, columns);
  };
  const notes = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

  if (state.view === 'help') {
    const lines = helpLines(ctx, st);
    const avail = body - 2;
    const top = Math.min(state.scroll, Math.max(0, lines.length - avail));
    const note =
      lines.length > avail ? `${top + 1}-${Math.min(lines.length, top + avail)} of ${lines.length}` : undefined;
    panels = panel(st, width, body, lines.slice(top, top + avail), {
      title: 'Keys',
      note,
      hints: [['any other key', 'close']],
    });
  } else if (state.view === 'detail' && job) {
    const { lines } = detailContent(job, ctx, st, state.details);
    const avail = body - 2;
    const top = Math.min(state.scroll, Math.max(0, lines.length - avail));
    const range =
      lines.length > avail ? `${top + 1}-${Math.min(lines.length, top + avail)} of ${lines.length}` : undefined;
    panels = panel(st, width, body, lines.slice(top, top + avail), {
      title: `Job · ${jobTitle(job)}`,
      note: notes(range, sideways(widthOf(lines), inner)),
      hints: [
        ['n/p', 'next/prev'],
        ['esc', 'back'],
      ],
      focused: true,
      pan: hscroll,
    });
  } else if (state.view === 'log') {
    const lines = ctx.store.log(state.wholeLog ? undefined : job);
    const title = state.wholeLog
      ? `Log · ${tildify(logFilePath(ctx.store.dataDir))}`
      : job
        ? `Log · ${jobTitle(job)}`
        : 'Log';
    const shown = lines.length ? lines : [st.muted(state.wholeLog ? 'no log yet' : 'nothing logged for this job yet')];
    const avail = body - 2;
    const max = Math.max(0, shown.length - avail);
    const top = state.follow ? max : Math.min(state.scroll, max);
    const range =
      shown.length > avail ? `lines ${top + 1}-${Math.min(shown.length, top + avail)} of ${shown.length}` : '';
    panels = panel(st, width, body, shown.slice(top, top + avail), {
      title,
      note: notes(range, state.follow ? 'following' : undefined, sideways(widthOf(lines), inner)),
      hints: [['L', state.wholeLog ? 'this job only' : 'whole log']],
      focused: true,
      pan: hscroll,
    });
  } else {
    // Jobs on top, taking LIST_SHARE of the body; the highlighted job's detail takes the rest when that leaves it at
    // least DETAIL_MIN rows, otherwise the table has the whole body.
    const split = job && body - DETAIL_MIN >= 5;
    const jobsH = split ? Math.min(body - DETAIL_MIN, Math.max(5, Math.round(body * LIST_SHARE))) : body;
    let lines: string[];
    let hidden: string | undefined;
    if (list.length === 0) {
      lines = wrapped(
        jobs.length === 0
          ? 'Jobs appear here as the daemon reviews PRs, or run one with: review-relay run --repo owner/name --pr N, or review a branch with: review-relay review -d'
          : 'no job matches the filter',
        inner,
        '',
      ).map((l) => st.muted(l));
    } else {
      const [head, ...rows] = listRows(state, ctx, st);
      // The table pans as one, the cursor marker staying at the edge.
      hidden = sideways(widthOf([head!, ...rows]), rowWidth(ctx));
      const marked = rows.map((r, i) =>
        i === cursor
          ? fill(`${st.tone('success', '▌')} ${pan(r, hscroll)}`, inner, st.base('selectionBg', 'selectionFg'))
          : `  ${pan(r, hscroll)}`,
      );
      lines = [`  ${pan(head!, hscroll)}`, ...windowed(marked, cursor, jobsH - 3, paintCode)];
    }
    panels = panel(st, width, jobsH, lines, {
      title: 'Jobs',
      note: notes(list.length > 1 ? `${cursor + 1} of ${list.length}` : undefined, hidden),
      hints: [
        ['/', 'filter'],
        ['s', 'status'],
      ],
      focused: true,
    });
    if (split) {
      panels.push(
        ...panel(st, width, body - jobsH, detailContent(job!, ctx, st).lines, {
          title: `Job · ${jobTitle(job!)}`,
          hints: [['enter', 'expand']],
        }),
      );
    }
  }

  const keys = footer(state, list, job, overflow > 0);
  return [row(header), row(status), ...panels.map(row), ...messages.map(row), row(` ${fitHints(st, keys, width - 1)}`)];
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

/**
 * Reviews a local job's branch again in the background, in the checkout it ran in. The branch's current head is
 * reviewed, so commits made since are included.
 */
function rerunLocal(job: JobRecord, config: Config, configPath: string): { text: string; tone: Tone } {
  if (!job.localPath || !job.branch || !job.base)
    return { text: 'this job lacks its branch or checkout', tone: 'danger' };
  if (!existsSync(job.localPath)) return { text: `${tildify(job.localPath)} no longer exists`, tone: 'danger' };
  const args = ['review', '--worker', '--config', configPath, '--base', job.base, '--head', job.branch];
  const pid = spawnDetached(config.dataDir, args, job.localPath);
  return { text: `re-reviewing ${jobTitle(job)} in the background (pid ${pid}); press l to follow`, tone: 'success' };
}

/** Performs `effect` and says what happened, for the flash line. */
export function perform(effect: Effect, config: Config, configPath: string): { text: string; tone: Tone } {
  switch (effect.kind) {
    case 'theme': {
      // Read the current file so a theme change cannot overwrite unrelated edits made since opening the TUI.
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a JSON object');
      writeFileSync(configPath, `${JSON.stringify({ ...raw, theme: effect.theme }, null, 2)}\n`);
      return {
        text:
          effect.theme === 'terminal'
            ? 'theme saved: terminal (syncing terminal colors)'
            : `theme saved: ${effect.theme}`,
        tone: 'success',
      };
    }
    case 'rerun': {
      const { job } = effect;
      if (isLocal(job)) return rerunLocal(job, config, configPath);
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
    case 'cancel': {
      const { job } = effect;
      if (!new StateStore(join(config.dataDir, 'state.json')).requestCancel(job.key)) {
        return { text: `${jobTitle(job)} already finished`, tone: 'warning' };
      }
      return { text: `cancelling ${jobTitle(job)}; its reviewers stop within a few seconds`, tone: 'success' };
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
  const color = supportsColor();
  const depth = colorDepth();
  const store = new JobStore(config.dataDir, prState, pricesFor(config));
  store.refresh();
  let daemon: DaemonState | null = await inspectDaemon(config.dataDir, config.port);
  let state = initialState(config.theme);
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
  const controller = new AbortController();
  const refreshPrs = () => {
    const list = visible(state, store.jobs);
    const cursor = cursorOf(state, list);
    const [height] = size();
    // Include the viewport and nearby rows without querying the whole history on every refresh.
    void store.refreshPrStates(
      list.slice(Math.max(0, cursor - height), cursor + height),
      Date.now(),
      controller.signal,
    );
  };
  refreshPrs();
  await runScreen({
    tickMs: 1000,
    tick: () => {
      store.refresh();
      refreshPrs();
      if (++ticks % DAEMON_EVERY === 0) {
        void inspectDaemon(config.dataDir, config.port).then((d) => (daemon = d));
      }
    },
    render: (height, width) => renderTui(state, ctx(height, width), themeStyles(color, depth, state.theme), version),
    key: (key) => {
      const [height, width] = size();
      state = reduce(state, key, ctx(height, width));
      if (state.effect) {
        let result: { text: string; tone: Tone };
        try {
          result = perform(state.effect, config, configPath);
        } catch (err) {
          const prefix = state.effect.kind === 'theme' ? 'theme applied, but not saved: ' : '';
          result = { text: prefix + (err instanceof Error ? err.message : String(err)), tone: 'danger' };
        }
        state = { ...state, effect: undefined, flash: { ...result, until: Date.now() + FLASH_MS } };
      }
      return !!state.done;
    },
  }).finally(() => controller.abort());
}
