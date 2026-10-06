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
import { renderMarkdownView, type MarkdownDetails } from './markdown.ts';
import { reportDirFor } from './report.ts';
import { activeJob, type JobRecord, type JobStatus } from './state.ts';
import { readReport, renderStatus, type ReportSummary } from './status.ts';
import { colorDepth, fill, moved, rgb, runScreen, windowed } from './term.ts';
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
import { mergeFindings, type Finding, type MergedFinding, type Verdict } from './verdict.ts';

const STATUSES: JobStatus[] = ['queued', 'running', 'done', 'failed', 'skipped', 'superseded'];
const STATUS_TONES: Record<JobStatus, Tone> = {
  queued: 'muted',
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'info',
  superseded: 'muted',
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

const isFinished = (job: JobRecord) => !activeJob(job);

/** Why a queued or running job can't be re-reviewed yet. */
const busyText = (job: JobRecord) =>
  `${job.repo} #${job.pr} ${job.status === 'queued' ? 'is queued for review' : 'is being reviewed now'}`;

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

  constructor(readonly dataDir: string) {}

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
    if (!this.reports.has(key)) this.reports.set(key, readReport(this.dirOf(job)));
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
    if (job) {
      const tag = `[${job.repo}]`;
      // A digit boundary, so PR #12's view doesn't pick up PR #120.
      const pr = new RegExp(`PR #${job.pr}(?!\\d)`);
      lines = lines.filter((l) => l.includes(tag) && (pr.test(l) || l.includes(job.key))).slice(-LOG_LINES);
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
  /** Disclosure state belongs to one review run, not another job or a later re-run. */
  details?: MarkdownDetails & { job: string };
  /** The log view shows the whole daemon log instead of the selected job's lines. */
  wholeLog: boolean;
  /** The log view keeps its end in view as lines arrive. */
  follow: boolean;
  /** A pending question, bound to the job it was asked about, so a list change can't retarget the answer. */
  confirm?: { action: 'rerun'; key: string };
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

/** Rows outside the body's panel: header, status, message, footer, and the panel's two borders. */
const CHROME = 6;
/** Lines a full-body panel shows. */
const room = (ctx: TuiContext) => Math.max(1, ctx.height - CHROME);

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
    case 'o':
      return { ...pinned, effect: { kind: 'open', url: prUrl(job) } };
    case 'y':
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
  const at = moved(cursorOf(state, list), key, list.length, Math.max(1, room(ctx) - 2));
  return at === undefined ? undefined : { ...state, selected: list[at]!.key };
}

/** Applies one key. Sets `done` to quit and `effect` for the loop to perform. */
export function reduce(state: TuiState, key: string, ctx: TuiContext): TuiState {
  if (key === 'ctrl-c') return { ...state, done: true };
  const base: TuiState = { ...state, effect: undefined };
  if (state.confirm) {
    const next = { ...base, confirm: undefined };
    if (key !== 'y') return flash(next, 'cancelled', ctx, 'muted');
    // The job as it is now, not as it was when asked: it may have gone, or a review of it may have started since.
    const job = ctx.store.jobs.find((j) => j.key === state.confirm!.key);
    if (!job) return flash(next, 'that job is no longer listed', ctx, 'warning');
    if (activeJob(job)) return flash(next, busyText(job), ctx, 'warning');
    return { ...next, effect: { kind: 'rerun', job } };
  }
  if (state.view === 'help') return { ...base, view: 'list' };
  if (state.filtering) return filtered(base, key, ctx);
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
      case 'right':
        return list.length
          ? { ...base, selected: list[cursorOf(state, list)]!.key, view: 'detail', scroll: 0, details: undefined }
          : base;
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
    const content = job ? detailContent(job, ctx, styles(false), state.details) : { lines: [], sections: [] };
    if (job && content.sections.length && ['[', ']', 'enter', 'space'].includes(key)) {
      const details = state.details?.job === cacheKey(job) ? state.details : { job: cacheKey(job) };
      const sections = content.sections;
      const at = sections.findIndex((s) => s.id === details.selected);
      const toggle = key === 'enter' || key === 'space';
      const index =
        at < 0
          ? key === '['
            ? sections.length - 1
            : Math.max(
                0,
                sections.findIndex((s) => s.line >= state.scroll),
              )
          : toggle
            ? at
            : (at + (key === ']' ? 1 : -1) + sections.length) % sections.length;
      const section = sections[index]!;
      let collapsed = details.collapsed ?? [];
      if (toggle) {
        collapsed = collapsed.includes(section.id)
          ? collapsed.filter((id) => id !== section.id)
          : [...collapsed, section.id];
      }
      const next = { ...base, details: { ...details, selected: section.id, collapsed } };
      const updated = detailContent(job, ctx, styles(false), next.details);
      // Put the selected header near the top so its body is visible after expansion.
      return { ...next, scroll: Math.max(0, Math.min(section.line - 1, updated.lines.length - room(ctx))) };
    }
    const scroll = scrolled(base, key, content.lines.length, room(ctx));
    if (scroll) return scroll;
    const list = visible(state, ctx.store.jobs);
    const at = cursorOf(state, list);
    switch (key) {
      case 'n':
      case 'right':
        return at < list.length - 1 ? { ...base, selected: list[at + 1]!.key, scroll: 0, details: undefined } : base;
      case 'p':
        return at > 0 ? { ...base, selected: list[at - 1]!.key, scroll: 0, details: undefined } : base;
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
  const scroll = scrolled(base, key, lines.length, room(ctx));
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
function detailContent(job: JobRecord, ctx: TuiContext, st: Styles, details?: TuiState['details']) {
  const detail = ctx.store.detail(job);
  let sections: { id: number; line: number }[] = [];
  const end = job.finishedAt ? Date.parse(job.finishedAt) : ctx.now;
  const took = fmtDuration(end - Date.parse(job.startedAt));
  const field = (label: string, value: string) => `  ${st.muted(label.padEnd(10))}${value}`;
  const lines = [
    `${st.bold(`${job.repo} #${job.pr}`)}  ${st.muted(job.headSha.slice(0, 8))}  ${st.badge(STATUS_TONES[job.status], job.status)}`,
    field('url', prUrl(job)),
    field('started', `${fmtTime(job.startedAt)}  ${st.muted(activeJob(job) ? `${took} so far` : took)}`),
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
      // Every finding field is reviewer output, paths included.
      const file = sanitize(f.file ?? '');
      const where = file ? (f.line ? `${file}:${f.line}` : file) : 'general';
      lines.push(
        `  ${st.tone(SEVERITY_TONES[f.severity] ?? 'muted', f.severity.padEnd(8))} ${st.bold(sanitize(f.title))}  ${st.muted(where)}`,
        `           ${st.muted(sanitize(f.detail).replace(/\s+/g, ' '))}`,
        `           ${st.muted(`by ${f.reviewers.join(', ')}`)}`,
      );
    }
  }

  if (job.status === 'superseded') {
    const head = job.supersededBy ? ` (${job.supersededBy.slice(0, 8)})` : '';
    lines.push('', st.muted(`  the PR moved to a newer commit${head} first, so nothing was posted`));
  }
  if (detail.comment.length) {
    // Two for the panel's padding and border on each side, two for the section indent.
    const width = Math.max(20, ctx.width - 6);
    const title = job.status === 'superseded' ? 'Comment (not posted)' : 'Comment';
    const comment = renderMarkdownView(
      detail.comment.join('\n'),
      width,
      st,
      details?.job === cacheKey(job) ? details : undefined,
    );
    lines.push('', st.section(title));
    sections = comment.sections.map((s) => ({ ...s, line: s.line + lines.length }));
    lines.push(...comment.lines.map((l) => `  ${l}`));
  } else if (activeJob(job) || job.status === 'failed') {
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

const HELP_LINES: [string, string][] = [
  ['↑↓ j k', 'move · g/G top and bottom · pgup/pgdn page'],
  ['enter', 'open the job: scores, findings, and the posted comment'],
  ['[ ]', 'previous/next Details or Dimension notes section in the comment'],
  ['enter space', 'expand/collapse the selected section while viewing a job'],
  ['n p', 'next and previous job while viewing one'],
  ['l', "the job's lines from the daemon log, following as they arrive"],
  ['L', 'the whole daemon log'],
  ['1 2 tab', 'switch between the Jobs and Log tabs'],
  ['r', 'review the PR again (asks first); runs in the background and logs to daemon.log'],
  ['o', 'open the PR in the browser'],
  ['y', "copy the PR's URL to the clipboard"],
  ['/', 'filter by repo, PR, commit, status, source, route, or error text'],
  ['s', 'cycle the status filter: queued, running, done, failed, skipped, superseded, all'],
  ['esc', 'back; on the list it clears the filters, then quits'],
  ['q', 'quit'],
];

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
 * The TUI's painter on the Model Router palette: 24-bit colors where the terminal takes them, else the nearest
 * basic colors with no painted backgrounds, else plain text.
 */
export function themeStyles(color: boolean, depth: ColorDepth = 'truecolor'): Theme {
  const paint = (code: string, s: string) => (color && s ? `${code}${s}${ANSI.reset}` : s);
  const swatch = (name: Swatch) => `\x1b[${depth === 'truecolor' ? rgb(PALETTE[name]) : BASIC[name]}m`;
  const base = (bg: Swatch, text: Swatch = 'fg') => {
    if (!color) return undefined;
    if (depth === 'truecolor') return `${rgb(PALETTE[bg], 'bg')};${rgb(PALETTE[text])}`;
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
    tabOn:
      depth === 'truecolor'
        ? `\x1b[${rgb(PALETTE.accent, 'bg')};${rgb(PALETTE.bg)}m${ANSI.bold}`
        : `\x1b[7;36m${ANSI.bold}`,
  };
}

/** `[key] label   [key] label`, keys in the accent. */
const hints = (st: Theme, pairs: [string, string][]) =>
  pairs
    .map(([key, label]) => `${st.paint(ANSI.bold + st.swatch('accent'), `[${key}]`)} ${st.muted(label)}`)
    .join('   ');

interface PanelOptions {
  title: string;
  /** Muted text in the top border, before the hints. */
  note?: string;
  hints?: [string, string][];
  focused?: boolean;
}

/** `lines` inside a rounded border, exactly `height` rows by `width` columns, with the title and hints in the top edge. */
function panel(st: Theme, width: number, height: number, lines: string[], opts: PanelOptions): string[] {
  const inner = Math.max(1, width - 4);
  const bg = st.base('panel');
  const edge = (s: string) => st.paint(st.swatch(opts.focused ? 'accent' : 'line'), s);
  const left = `${edge('╭─')} ${st.bold(opts.title)} `;
  const tail = [opts.note && st.muted(opts.note), opts.hints?.length && hints(st, opts.hints)]
    .filter(Boolean)
    .join('  ');
  let right = tail ? ` ${tail} ${edge('─╮')}` : edge('─╮');
  let dashes = width - visibleLength(left) - visibleLength(right);
  if (dashes < 0) {
    right = edge('─╮');
    dashes = Math.max(0, width - visibleLength(left) - 2);
  }
  const top = fill(`${left}${edge('─'.repeat(dashes))}${right}`, width, bg);
  const rows = Array.from({ length: Math.max(0, height - 2) }, (_, i) =>
    fill(`${edge('│')} ${fill(lines[i] ?? '', inner, bg)} ${edge('│')}`, width, bg),
  );
  const bottom = fill(edge(`╰${'─'.repeat(Math.max(0, width - 2))}╯`), width, bg);
  return [top, ...rows, bottom];
}

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

/** The footer's key hints for the current view. */
function footer(state: TuiState, list: JobRecord[]): [string, string][] {
  if (state.confirm)
    return [
      ['y', 're-run'],
      ['any other key', 'cancel'],
    ];
  if (state.filtering) {
    return [
      ['type', 'to filter'],
      ['↑↓', 'move'],
      ['enter', 'keep filter'],
      ['esc', 'clear it'],
    ];
  }
  const job: [string, string][] = list.length
    ? [
        ['l', 'log'],
        ['r', 're-run'],
        ['o', 'open PR'],
        ['y', 'copy url'],
      ]
    : [];
  switch (state.view) {
    case 'help':
      return [['any key', 'closes help']];
    case 'detail':
      return [['[/]', 'details'], ['enter', 'toggle'], ['↑↓', 'scroll'], ['n/p', 'next/prev'], ...job, ['esc', 'back']];
    case 'log':
      return [
        ['↑↓', 'scroll'],
        ['G', 'follow'],
        ['L', state.wholeLog ? 'this job only' : 'whole log'],
        ['esc', 'back'],
      ];
    default:
      return [
        ['↑↓', 'move'],
        ...(list.length ? ([['enter', 'open']] as [string, string][]) : []),
        ...job,
        ['/', 'filter'],
        ['s', 'status'],
        ['?', 'help'],
        state.filter || state.status ? ['esc', 'clear filter'] : ['q', 'quit'],
      ];
  }
}

/** The smallest terminal the layout fits; below it the screen only asks for more room. */
export const MIN_SIZE = { width: 60, height: 14 };

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
  const left = ` ${st.tone('success', '◆')} ${st.bold('REVIEW-RELAY')}  ${tabs.join(' ')}`;
  const right = st.muted(`${tildify(ctx.store.dataDir)} · v${version} `);
  const gap = width - visibleLength(left) - visibleLength(right);
  const header = gap >= 4 ? `${left}${' '.repeat(gap)}${right}` : left;

  // Status: the daemon, the counts, and the active filters.
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
  const status = ` ${daemonLine(ctx, st)}  ${st.muted('│')}  ${summary}${narrowed}  ${[statusText, filterText].filter(Boolean).join(' ')}`;

  // Message: a confirmation, a flash, or nothing.
  const live = state.flash && state.flash.until > ctx.now ? state.flash : undefined;
  const asked = state.confirm && jobs.find((j) => j.key === state.confirm!.key);
  const message = asked
    ? ` ${st.badge('warning', `review ${asked.repo} #${asked.pr} again with the configured reviewers?`)}`
    : live
      ? ` ${st.badge(live.tone, live.text)}`
      : '';

  const body = height - 4;
  const inner = Math.max(1, width - 4);
  const paintCode = (code: string, text: string) => st.paint(`\x1b[${code}m`, text);
  let panels: string[];

  if (state.view === 'help') {
    const w = Math.max(...HELP_LINES.map(([k]) => k.length));
    const lines = HELP_LINES.map(([k, what]) => `${st.key(k.padEnd(w))}  ${what}`);
    panels = panel(st, width, body, lines, { title: 'Keys', hints: [['any key', 'close']] });
  } else if (state.view === 'detail' && job) {
    const { lines } = detailContent(job, ctx, st, state.details);
    const avail = body - 2;
    const top = Math.min(state.scroll, Math.max(0, lines.length - avail));
    const note =
      lines.length > avail ? `${top + 1}-${Math.min(lines.length, top + avail)} of ${lines.length}` : undefined;
    panels = panel(st, width, body, lines.slice(top, top + avail), {
      title: `Job · ${job.repo} #${job.pr}`,
      note,
      hints: [
        ['n/p', 'next/prev'],
        ['esc', 'back'],
      ],
      focused: true,
    });
  } else if (state.view === 'log') {
    const lines = ctx.store.log(state.wholeLog ? undefined : job);
    const title = state.wholeLog
      ? `Log · ${tildify(logFilePath(ctx.store.dataDir))}`
      : job
        ? `Log · ${job.repo} #${job.pr}`
        : 'Log';
    const shown = lines.length ? lines : [st.muted(state.wholeLog ? 'no log yet' : 'nothing logged for this job yet')];
    const avail = body - 2;
    const max = Math.max(0, shown.length - avail);
    const top = state.follow ? max : Math.min(state.scroll, max);
    const range =
      shown.length > avail ? `lines ${top + 1}-${Math.min(shown.length, top + avail)} of ${shown.length}` : '';
    const note = [range, state.follow && 'following'].filter(Boolean).join(' · ') || undefined;
    panels = panel(st, width, body, shown.slice(top, top + avail), {
      title,
      note,
      hints: [['L', state.wholeLog ? 'this job only' : 'whole log']],
      focused: true,
    });
  } else {
    // Jobs on top; the highlighted job's detail below when there is room for both.
    const detailMin = 8;
    const wanted = Math.max(5, list.length + 3);
    const split = job && body - detailMin >= 5;
    const jobsH = split ? Math.min(body - detailMin, wanted) : body;
    let lines: string[];
    if (list.length === 0) {
      lines = [
        st.muted(
          jobs.length === 0
            ? 'Jobs appear here as the daemon reviews PRs, or run one with: review-relay run --repo owner/name --pr N'
            : 'no job matches the filter',
        ),
      ];
    } else {
      const [head, ...rows] = renderStatus(list, {
        dataDir: ctx.store.dataDir,
        reviewers: ctx.reviewers,
        color: st.color,
        now: ctx.now,
        reports: list.map((j) => ctx.store.report(j)),
      });
      const marked = rows.map((r, i) =>
        i === cursor ? fill(`${st.tone('success', '▌')} ${r}`, inner, st.base('selectionBg', 'selectionFg')) : `  ${r}`,
      );
      lines = [`  ${head}`, ...windowed(marked, cursor, jobsH - 3, paintCode)];
    }
    panels = panel(st, width, jobsH, lines, {
      title: 'Jobs',
      note: list.length > 1 ? `${cursor + 1} of ${list.length}` : undefined,
      hints: [
        ['/', 'filter'],
        ['s', 'status'],
      ],
      focused: true,
    });
    if (split) {
      panels.push(
        ...panel(st, width, body - jobsH, detailContent(job!, ctx, st).lines, {
          title: `Job · ${job!.repo} #${job!.pr}`,
          hints: [['enter', 'expand']],
        }),
      );
    }
  }

  return [row(header), row(status), ...panels.map(row), row(message), row(` ${hints(st, footer(state, list))}`)];
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
  const st = themeStyles(supportsColor(), colorDepth());
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
