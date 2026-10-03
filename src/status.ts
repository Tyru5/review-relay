import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportDirFor } from './report.ts';
import type { JobRecord } from './state.ts';
import type { ReviewerId } from './types.ts';
import { mergeFindings, type Finding, type Severity } from './verdict.ts';

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

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
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
const STATUS_COLORS: Record<string, string> = { done: GREEN, failed: RED, running: YELLOW, skipped: CYAN };
const scoreColor = (n: number) => (n >= 4 ? GREEN : n === 3 ? YELLOW : RED);
const countCell = (n: number, color: string): Cell => (n > 0 ? { text: String(n), color } : { text: '0', color: DIM });

export interface StatusOptions {
  dataDir: string;
  reviewers: ReviewerId[];
  color: boolean;
  now?: number;
}

/** Recent jobs as an aligned table with a header row; ROUTE and NOTE (errors) are dropped when no job has one. */
export function renderStatus(records: JobRecord[], opts: StatusOptions): string[] {
  if (records.length === 0) return ['no review jobs yet'];
  const now = opts.now ?? Date.now();
  const reports = records.map((r) =>
    r.status === 'running' ? null : readReport(r.reportDir ?? reportDirFor(opts.dataDir, r)),
  );
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
    const end = r.finishedAt ? Date.parse(r.finishedAt) : r.status === 'running' ? now : null;
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
      { text: `#${r.pr}` },
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
      { text: oneLine(r.error ?? failures.join('; '), 80), color: DIM },
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
  const paint = ({ text, color }: Cell) => (opts.color && color && text ? `\x1b[${color}m${text}\x1b[0m` : text);
  const line = (cells: Cell[]) =>
    cells
      .map((cell, c) =>
        c === cells.length - 1 ? paint(cell) : paint(cell) + ' '.repeat(widths[c]! - cell.text.length),
      )
      .join('  ')
      .trimEnd();
  return [line(header.map((text) => ({ text, color: DIM }))), ...rows.map(line)];
}
