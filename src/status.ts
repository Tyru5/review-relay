import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportDirFor } from './report.ts';
import { activeJob, jobTarget, type JobRecord } from './state.ts';
import type { ReviewerId } from './types.ts';
import { fmtDuration, sanitize, type Styles, type Tone } from './ui.ts';
import { mergeFindings, type Finding, type Severity } from './verdict.ts';

export { fmtDuration };

interface ReviewerMeta {
  name: ReviewerId;
  ok: boolean;
  score?: number;
  error?: string;
  durationMs: number;
}

export interface ReportSummary {
  score: number | null;
  reviewers: ReviewerMeta[];
  findings: Record<Severity, number>;
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Scores, timings, and merged finding counts from a report directory; null when it was never written. */
export function readReport(dir: string): ReportSummary | null {
  const meta = readJson(join(dir, 'meta.json'));
  if (!meta || !Array.isArray(meta.reviewers)) return null;
  const reviewers = meta.reviewers as ReviewerMeta[];
  const byReviewer = reviewers
    .filter((r) => r.ok)
    .map((r) => ({
      reviewer: r.name,
      findings: (readJson(join(dir, `${r.name}.json`))?.verdict?.findings ?? []) as Finding[],
    }));
  const findings = { critical: 0, major: 0, minor: 0 };
  for (const f of mergeFindings(byReviewer)) findings[f.severity]++;
  return { score: meta.score ?? null, reviewers, findings };
}

const fmtStarted = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type Cell = { text: string; color?: string };

const DIM = '2';
const RED = '31';
const GREEN = '32';
const YELLOW = '33';
const CYAN = '36';
const STATUS_COLORS: Record<string, string> = {
  queued: DIM,
  done: GREEN,
  failed: RED,
  running: YELLOW,
  skipped: CYAN,
  superseded: DIM,
};
const scoreColor = (n: number) => (n >= 4 ? GREEN : n === 3 ? YELLOW : RED);
const countCell = (n: number, color: string): Cell => (n > 0 ? { text: String(n), color } : { text: '0', color: DIM });

export interface StatusOptions {
  dataDir: string;
  reviewers: ReviewerId[];
  color: boolean;
  /** The TUI supplies its palette; CLI status keeps the terminal's ANSI colors. */
  styles?: Styles;
  now?: number;
  /** One summary per record, when the caller has them already (the TUI caches them); else they are read here. */
  reports?: (ReportSummary | null)[];
}

/** Recent jobs as an aligned table with a header row; ROUTE and NOTE (errors) are dropped when no job has one. */
export function renderStatus(records: JobRecord[], opts: StatusOptions): string[] {
  if (records.length === 0) return ['no review jobs yet'];
  const now = opts.now ?? Date.now();
  const reports =
    opts.reports ??
    records.map((r) => (activeJob(r) ? null : readReport(r.reportDir ?? reportDirFor(opts.dataDir, r))));
  const reviewers = [...opts.reviewers];
  for (const rep of reports)
    for (const r of rep?.reviewers ?? []) if (!reviewers.includes(r.name)) reviewers.push(r.name);

  const header = [
    'STATUS',
    'STARTED',
    'TIME',
    'REPO',
    'PR',
    'COMMIT',
    'SOURCE',
    'ROUTE',
    'SCORE',
    ...reviewers.map((n) => n.toUpperCase()),
    'CRIT',
    'MAJ',
    'MIN',
    'NOTE',
  ];
  const none: Cell = { text: '-', color: DIM };

  const rows = records.map((r, i): Cell[] => {
    const rep = reports[i];
    const end = r.finishedAt ? Date.parse(r.finishedAt) : activeJob(r) ? now : null;
    const reviewerCells = reviewers.map((name): Cell => {
      const m = rep?.reviewers.find((x) => x.name === name);
      if (!m) return none;
      if (!m.ok) return { text: `failed ${fmtDuration(m.durationMs)}`, color: RED };
      return { text: `${m.score}/5 ${fmtDuration(m.durationMs)}`, color: scoreColor(m.score ?? 1) };
    });
    const failures = rep?.reviewers.filter((m) => !m.ok && m.error).map((m) => `${m.name}: ${m.error}`) ?? [];
    return [
      { text: r.status, color: STATUS_COLORS[r.status] },
      { text: fmtStarted(r.startedAt) },
      end === null ? none : { text: fmtDuration(end - Date.parse(r.startedAt)) },
      { text: r.repo },
      { text: jobTarget(r) },
      { text: r.headSha.slice(0, 8) },
      { text: r.source, color: DIM },
      r.route ? { text: r.route } : none,
      rep?.score ? { text: `${rep.score}/5`, color: scoreColor(rep.score) } : none,
      ...reviewerCells,
      ...(rep
        ? [
            countCell(rep.findings.critical, RED),
            countCell(rep.findings.major, YELLOW),
            countCell(rep.findings.minor, ''),
          ]
        : [none, none, none]),
      // Reviewer errors quote CLI output, so they are untrusted.
      {
        text: r.supersededBy
          ? `PR moved to ${r.supersededBy.slice(0, 8)}; not posted`
          : oneLine(sanitize(r.error ?? failures.join('; ')), 80),
        color: DIM,
      },
    ];
  });

  if (rows.every((row) => !row.at(-1)!.text)) {
    header.pop();
    for (const row of rows) row.pop();
  }
  if (records.every((r) => !r.route)) {
    const route = header.indexOf('ROUTE');
    header.splice(route, 1);
    for (const row of rows) row.splice(route, 1);
  }
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c]!.text.length)));
  const tones: Record<string, Tone> = {
    [DIM]: 'muted',
    [RED]: 'danger',
    [GREEN]: 'success',
    [YELLOW]: 'warning',
    [CYAN]: 'info',
  };
  const paint = ({ text, color }: Cell) => {
    if (!opts.color || !color || !text) return text;
    return opts.styles ? opts.styles.tone(tones[color]!, text) : `\x1b[${color}m${text}\x1b[0m`;
  };
  const line = (cells: Cell[]) =>
    cells
      .map((cell, c) =>
        c === cells.length - 1 ? paint(cell) : paint(cell) + ' '.repeat(widths[c]! - cell.text.length),
      )
      .join('  ')
      .trimEnd();
  return [line(header.map((text) => ({ text, color: DIM }))), ...rows.map(line)];
}

export interface Page<T> {
  items: T[];
  /** 1-based, clamped to the last page. */
  page: number;
  pages: number;
  total: number;
  /** 1-based index of the first item shown; 0 when there are none. */
  from: number;
  to: number;
}

/** One page of `items`; a page past the end shows the last one. */
export function paginate<T>(items: T[], page: number, size: number): Page<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: current, pages, total, from: slice.length ? start + 1 : 0, to: start + slice.length };
}
