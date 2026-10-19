/**
 * `review-relay scorecard`: how each reviewer's findings fared, judged by what the PR's next commit did about them.
 * A finding is `addressed` when the next commit changed the lines it named and no reviewer reported it again,
 * `attempted` when the lines changed but it was reported again, `ignored` when the lines stayed and it was reported
 * again, and `dropped` when the lines stayed and no reviewer repeated it, which points at a finding that was noise.
 * A finding whose reviewers all failed on the next commit waits for the pair where one of them runs again.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { exec } from './exec.ts';
import { matchFindings, readFindings } from './lifecycle.ts';
import { DIM, renderTable, type Cell, type ReviewerMeta } from './status.ts';
import type { ReviewerId } from './types.ts';
import { row, type Styles } from './ui.ts';
import { fmtCost, recordedUsage, totalCost, type CostTotal, type Price } from './usage.ts';
import type { MergedFinding } from './verdict.ts';

export type Outcome = 'addressed' | 'attempted' | 'ignored' | 'dropped' | 'unknown';
export const OUTCOMES: Outcome[] = ['addressed', 'attempted', 'ignored', 'dropped', 'unknown'];

/** One PR review as its report folder records it. */
export interface ReportRef {
  repo: string;
  pr: number;
  headSha: string;
  finishedAt: string;
  dir: string;
  reviewers: ReviewerMeta[];
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

/** Every PR review with a report under `dataDir/reports`, by repo folder; local reviews are left out. */
export function listReports(dataDir: string, repo?: string, prices?: Record<string, Price>): ReportRef[] {
  const root = join(dataDir, 'reports');
  const refs: ReportRef[] = [];
  for (const repoDir of entries(root)) {
    for (const prDir of entries(join(root, repoDir))) {
      if (!prDir.startsWith('pr-')) continue;
      for (const shaDir of entries(join(root, repoDir, prDir))) {
        const dir = join(root, repoDir, prDir, shaDir);
        const meta = readJson(join(dir, 'meta.json'));
        if (typeof meta?.repo !== 'string' || typeof meta.headSha !== 'string' || !Array.isArray(meta.reviewers))
          continue;
        if (repo && meta.repo.toLowerCase() !== repo.toLowerCase()) continue;
        const pr = Number(meta.pr) || Number(prDir.slice(3));
        if (!Number.isInteger(pr) || pr <= 0) continue;
        refs.push({
          repo: meta.repo,
          pr,
          headSha: meta.headSha,
          finishedAt: typeof meta.finishedAt === 'string' ? meta.finishedAt : '',
          dir,
          reviewers: (meta.reviewers as ReviewerMeta[]).map((r) => ({
            ...r,
            usage: recordedUsage(r.usage, r.model, prices),
          })),
        });
      }
    }
  }
  return refs.toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** Old-side line ranges a diff changed, by old path: `[start, end]` inclusive; an insertion covers the line it follows. */
export type ChangedLines = Map<string, [number, number][]>;

/** Parses `git diff --unified=0` output into the lines it touched, by the file's path before the change. */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let file: string | undefined;
  // Between a file's `diff --git` line and its first hunk; a removed line that starts with `-- ` looks like `---`.
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `a/x b/y`; a path with a space is rare and the --- line below fixes it when present.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = m?.[1];
      header = true;
      if (file && !changed.has(file)) changed.set(file, []);
    } else if (header && line.startsWith('--- ')) {
      const old = line.slice(4).split('\t')[0]!;
      file = old === '/dev/null' ? undefined : old.replace(/^a\//, '');
      if (file && !changed.has(file)) changed.set(file, []);
    } else if (line.startsWith('@@ ') && file) {
      header = false;
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      changed.get(file)!.push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return changed;
}

/** Lines this close to a finding's line count as the finding's lines. */
const NEARBY = 3;

/** True when the diff touched the finding's lines, or its file at all for a finding without a line. */
export function touched(changed: ChangedLines, f: { file: string; line: number | null }): boolean {
  const ranges = changed.get(f.file);
  if (!ranges) return false;
  if (f.line === null) return true;
  return ranges.some(([start, end]) => end >= f.line! - NEARBY && start <= f.line! + NEARBY);
}

/**
 * What the next commit did about one merged finding, given whether the next review repeated it (`matchFindings`
 * decides, the same way the comment does). Unknown without a diff and for a finding that names no file (no lines to
 * watch).
 */
export function outcomeOf(f: MergedFinding, repeated: boolean, changed: ChangedLines | null): Outcome {
  if (!changed || !f.file) return 'unknown';
  const moved = touched(changed, f);
  if (moved) return repeated ? 'attempted' : 'addressed';
  return repeated ? 'ignored' : 'dropped';
}

export interface ReviewerScore {
  name: ReviewerId;
  /** Reviews it ran in that a later review of the same PR followed, so its findings could be judged. */
  reviews: number;
  findings: number;
  outcomes: Record<Outcome, number>;
  /** Findings it alone reported when others ran too, and how many of those were addressed. */
  unique: { findings: number; addressed: number };
  /** Findings at least one other reviewer also reported. */
  agreed: number;
  /** Critical and major findings, and how many of those were ignored or dropped. */
  severe: { findings: number; ignored: number; dropped: number };
  /** Mean of its score minus the panel's mean score, over reviews where two or more reviewers succeeded. */
  scoreDelta: number | null;
  /** What those reviews cost it, when the CLI reported usage. */
  cost: CostTotal | null;
}

export interface Scorecard {
  reviews: number;
  /** Consecutive pairs of reviews of one PR that were compared. */
  pairs: number;
  /** Pairs whose commits git could not diff, so their findings are `unknown`. */
  unknownPairs: number;
  reviewers: ReviewerScore[];
}

export interface ScorecardDeps {
  /** `git diff --unified=0 <prior> <next>` in the repo's clone; null when the clone or a commit is missing. */
  diff: (localPath: string, prior: string, next: string) => Promise<string | null>;
}

/**
 * Plain hunks with old-side line numbers, whatever the user's git config: no external diff tool (its output has no
 * hunks, so every finding would read as untouched), no textconv (it rewrites line numbers), no color, paths with
 * non-ASCII characters unquoted, and the `a/` `b/` prefixes the parser expects.
 */
export const diffCommand = (localPath: string, prior: string, next: string) => [
  'git',
  '-C',
  localPath,
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--unified=0',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  prior,
  next,
];

export const SCORECARD_DEPS: ScorecardDeps = {
  diff: async (localPath, prior, next) => {
    const r = await exec(diffCommand(localPath, prior, next));
    return r.code === 0 ? r.stdout : null;
  },
};

const zero = (): Record<Outcome, number> => ({ addressed: 0, attempted: 0, ignored: 0, dropped: 0, unknown: 0 });

/**
 * Judges every reviewer's findings by the PR's next reviewed commit, across the reports in `dataDir`. Reviews that
 * no later review followed are not judged, since nothing says what became of their findings. Reviewers come in config
 * order, then any others the reports name.
 */
export async function scorecard(
  config: Config,
  reports: ReportRef[],
  deps: ScorecardDeps = SCORECARD_DEPS,
): Promise<Scorecard> {
  const byReviewer = new Map<ReviewerId, ReviewerScore>();
  const deltas = new Map<ReviewerId, number[]>();
  const costs = new Map<ReviewerId, (ReviewerMeta['usage'] | undefined)[]>();
  const scoreOf = (name: ReviewerId): ReviewerScore => {
    let s = byReviewer.get(name);
    if (!s) {
      s = {
        name,
        reviews: 0,
        findings: 0,
        outcomes: zero(),
        unique: { findings: 0, addressed: 0 },
        agreed: 0,
        severe: { findings: 0, ignored: 0, dropped: 0 },
        scoreDelta: null,
        cost: null,
      };
      byReviewer.set(name, s);
    }
    return s;
  };
  for (const name of config.reviewers) scoreOf(name);

  const byPr = new Map<string, ReportRef[]>();
  for (const ref of reports) {
    const key = `${ref.repo.toLowerCase()}#${ref.pr}`;
    byPr.set(key, [...(byPr.get(key) ?? []), ref]);
  }
  let pairs = 0;
  let unknownPairs = 0;
  for (const reviews of byPr.values()) {
    // A review where every reviewer failed saw nothing, so it neither judges nor is judged.
    const history = reviews.filter((r) => r.reviewers.some((m) => m.ok));
    for (let i = 0; i + 1 < history.length; i++) {
      const prior = history[i]!;
      const next = history[i + 1]!;
      // The prior's findings and the ones it carried forward unjudged: the same set the comment tracked against.
      const before = readFindings(prior.dir, { carried: true });
      const after = readFindings(next.dir);
      if (!before || !after) continue;
      pairs++;
      const nextOk = next.reviewers.filter((r) => r.ok).map((r) => r.name);
      const repeated = new Set(matchFindings(before, after).values());
      const repo = config.repos.find((r) => r.fullName.toLowerCase() === prior.repo.toLowerCase());
      // Every reviewer that reported a finding failed this time: nothing says what became of it, so the review
      // carries it forward and the next pair judges it.
      const judged = before.filter((f) => f.reviewers.some((r) => nextOk.includes(r)));
      // A carried finding's lines hold at the commit it was last reported on, so it is diffed from there.
      const changedFrom = new Map<string, ChangedLines | null>();
      for (const f of judged) {
        const base = f.lastSeen ?? prior.headSha;
        if (changedFrom.has(base)) continue;
        const diff = repo ? await deps.diff(repo.localPath, base, next.headSha) : null;
        changedFrom.set(base, diff === null ? null : parseChangedLines(diff));
      }
      if ([...changedFrom.values()].includes(null)) unknownPairs++;

      const ok = prior.reviewers.filter((r) => r.ok);
      for (const r of ok) {
        const s = scoreOf(r.name);
        s.reviews++;
        costs.set(r.name, [...(costs.get(r.name) ?? []), r.usage]);
      }
      if (ok.length >= 2) {
        const mean = ok.reduce((n, r) => n + (r.score ?? 0), 0) / ok.length;
        for (const r of ok) deltas.set(r.name, [...(deltas.get(r.name) ?? []), (r.score ?? 0) - mean]);
      }
      for (const f of judged) {
        const outcome = outcomeOf(f, repeated.has(f), changedFrom.get(f.lastSeen ?? prior.headSha) ?? null);
        const severe = f.severity !== 'minor';
        // Unique: one reviewer alone, when others ran (agreement is unset when one reviewer ran).
        const alone = f.reviewers.length === 1 && f.agreement !== undefined;
        for (const name of f.reviewers) {
          const s = scoreOf(name);
          s.findings++;
          s.outcomes[outcome]++;
          if (alone) {
            s.unique.findings++;
            if (outcome === 'addressed') s.unique.addressed++;
          } else if (f.reviewers.length > 1) s.agreed++;
          if (severe) {
            s.severe.findings++;
            if (outcome === 'ignored') s.severe.ignored++;
            if (outcome === 'dropped') s.severe.dropped++;
          }
        }
      }
    }
  }
  for (const s of byReviewer.values()) {
    const d = deltas.get(s.name);
    s.scoreDelta = d?.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
    s.cost = totalCost(costs.get(s.name) ?? []);
  }
  return {
    reviews: reports.length,
    pairs,
    unknownPairs,
    reviewers: [...byReviewer.values()].filter((s) => s.reviews > 0 || config.reviewers.includes(s.name)),
  };
}

const pct = (n: number, of: number) => (of ? `${n} (${Math.round((100 * n) / of)}%)` : '0');
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

/** One row per reviewer: how many of its findings the next commit addressed, ignored, or that it dropped itself. */
export function renderScorecard(card: Scorecard, opts: { color: boolean; styles?: Styles }): string[] {
  if (card.pairs === 0) return ['no PR has two reviewed commits yet, so there is nothing to judge findings against'];
  const header = [
    'REVIEWER',
    'REVIEWS',
    'FINDINGS',
    'ADDRESSED',
    'ATTEMPTED',
    'IGNORED',
    'DROPPED',
    'UNIQUE ADDRESSED',
    'AGREED',
    'SEVERE IGNORED',
    'SCORE VS PANEL',
    'COST / ADDRESSED',
  ];
  const none: Cell = { text: '-', color: DIM };
  const rows = card.reviewers.map((s): Cell[] => {
    const judged = s.findings - s.outcomes.unknown;
    const perAddressed =
      s.cost && s.outcomes.addressed > 0 ? { ...s.cost, costUsd: s.cost.costUsd / s.outcomes.addressed } : null;
    return [
      { text: s.name },
      { text: String(s.reviews) },
      { text: s.outcomes.unknown ? `${s.findings} (${s.outcomes.unknown} unknown)` : String(s.findings) },
      { text: pct(s.outcomes.addressed, judged), color: s.outcomes.addressed ? '32' : DIM },
      { text: pct(s.outcomes.attempted, judged) },
      { text: pct(s.outcomes.ignored, judged), color: s.outcomes.ignored ? '33' : DIM },
      { text: pct(s.outcomes.dropped, judged), color: s.outcomes.dropped ? '31' : DIM },
      s.unique.findings ? { text: `${s.unique.addressed} of ${s.unique.findings}` } : none,
      { text: pct(s.agreed, s.findings) },
      s.severe.findings ? { text: `${s.severe.ignored + s.severe.dropped} of ${s.severe.findings}` } : none,
      s.scoreDelta === null ? none : { text: signed(s.scoreDelta) },
      perAddressed ? { text: fmtCost(perAddressed) } : none,
    ];
  });
  return renderTable(header, rows, opts);
}

/** What the table rests on, and what stands out. */
export function renderScorecardNotes(card: Scorecard, st: Styles): string[] {
  const lines = [
    row(
      st,
      'judged',
      `${card.pairs} ${card.pairs === 1 ? 'pair' : 'pairs'} of reviews`,
      `consecutive reviewed commits of one PR, out of ${card.reviews} PR reviews`,
    ),
  ];
  if (card.unknownPairs > 0) {
    lines.push(
      `  ${st.muted(`${card.unknownPairs} ${card.unknownPairs === 1 ? 'pair' : 'pairs'} could not be diffed (repo not configured, or commits gone from the clone), so their findings are unknown`)}`,
    );
  }
  const notes: string[] = [];
  for (const s of card.reviewers) {
    const judged = s.findings - s.outcomes.unknown;
    if (judged >= 10 && s.outcomes.dropped * 2 > judged) {
      notes.push(
        `${s.name} dropped ${s.outcomes.dropped} of ${judged} findings itself on the next commit: a sign of noise`,
      );
    }
    if (s.unique.findings >= 5 && s.unique.addressed === 0) {
      notes.push(`${s.name}: none of its ${s.unique.findings} findings that no other reviewer had were addressed`);
    }
    if (s.severe.findings >= 5 && (s.severe.ignored + s.severe.dropped) * 2 > s.severe.findings) {
      notes.push(
        `${s.name}: ${s.severe.ignored + s.severe.dropped} of its ${s.severe.findings} critical or major findings were ignored or dropped`,
      );
    }
  }
  return notes.length ? [...lines, '', ...notes.map((n) => `  ${st.muted(n)}`)] : lines;
}
