/**
 * What happened to a PR's findings between one reviewed commit and the next. Every review writes `findings.json`
 * next to its `meta.json`: the findings merged across reviewers, each marked `new` or `open` since the commit it was
 * first reported on, plus the prior review's findings that no reviewer reported again, as `fixed`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reportDirFor } from './report.ts';
import { isLocal, type JobSource } from './types.ts';
import { mergeFindings, SAME_TITLE, sameSpot, titleSimilarity, type Finding, type MergedFinding } from './verdict.ts';

export type FindingStatus = 'new' | 'open';

export interface TrackedFinding extends MergedFinding {
  /** Set when a prior review of the PR exists: `open` when it reported this finding too. */
  status?: FindingStatus;
  /** The commit the finding was first reported on, for an `open` one. */
  since?: string;
  /** For a carried finding, the commit it was last reported on, where its line numbers hold. */
  lastSeen?: string;
}

/** A prior finding no reviewer reported again on the new commit. */
export interface FixedFinding extends Pick<Finding, 'severity' | 'dimension' | 'file' | 'line' | 'title'> {
  reviewers: string[];
  /** The commit it was first reported on. */
  since: string;
  /** The commit it was last reported on, where its line numbers hold: the prior commit unless it was carried. */
  lastSeen: string;
}

/** The merged findings of one review, tracked against the review before it. */
export interface TrackedReport {
  headSha: string;
  /** The commit whose review these were tracked against; null for the PR's first review. */
  prior: string | null;
  findings: TrackedFinding[];
  fixed: FixedFinding[];
  /**
   * Prior findings this review could not judge, because every reviewer that reported them failed or didn't run.
   * Not shown, but kept so the next review still knows them and an open finding keeps its history.
   */
  carried?: TrackedFinding[];
}

export interface PriorReview {
  headSha: string;
  findings: TrackedFinding[];
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * True when a finding on the new commit is the one `prior` reported: same file, and either the titles agree or both
 * name lines within 3 of each other and the dimensions don't disagree. Lines shift as commits land, so the title
 * carries most weight; a finding without a line matches on title alone, since "somewhere in this file" is no spot.
 */
export function sameFinding(prior: Finding, next: Finding): boolean {
  if (prior.file !== next.file) return false;
  if (titleSimilarity(prior.title, next.title) >= SAME_TITLE) return true;
  if (prior.line === null || next.line === null) return false;
  const dimensionsAgree = !prior.dimension || !next.dimension || prior.dimension === next.dimension;
  return dimensionsAgree && sameSpot(prior, next);
}

/** The ids of the reviewers that succeeded in a report, or none when its `meta.json` is missing or unreadable. */
export function okReviewers(dir: string): string[] {
  const meta = readJson(join(dir, 'meta.json'));
  if (!Array.isArray(meta?.reviewers)) return [];
  return (meta.reviewers as { name: string; ok: boolean }[]).filter((r) => r.ok).map((r) => r.name);
}

/**
 * A report's merged findings: `findings.json` when the review wrote one, else merged from each reviewer's file.
 * Null when no reviewer succeeded, since a review that saw nothing says nothing about the findings before it. With
 * `carried`, the findings it carried forward unjudged come too, for tracking the next review against it.
 */
export function readFindings(dir: string, opts: { carried?: boolean } = {}): TrackedFinding[] | null {
  const ok = okReviewers(dir);
  if (ok.length === 0) return null;
  const tracked = readJson(join(dir, 'findings.json'));
  if (Array.isArray(tracked?.findings)) {
    const carried = opts.carried && Array.isArray(tracked.carried) ? (tracked.carried as TrackedFinding[]) : [];
    return [...(tracked.findings as TrackedFinding[]), ...carried];
  }
  const byReviewer = ok.map((name) => ({
    reviewer: name,
    findings: (readJson(join(dir, `${name}.json`))?.verdict?.findings ?? []) as Finding[],
  }));
  return mergeFindings(byReviewer);
}

/**
 * The latest earlier review of the same PR (or, for a local review, of the same branch) in which a reviewer
 * succeeded, from the report folders next to this job's. A re-review of the same commit replaces its report, so that
 * commit is never its own prior.
 */
export function priorReview(
  dataDir: string,
  job: { repo: string; pr: number; headSha: string; source?: JobSource; headRef?: string },
): PriorReview | null {
  const own = reportDirFor(dataDir, job);
  const parent = dirname(own);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  const candidates: { finishedAt: string; headSha: string; dir: string }[] = [];
  for (const name of names) {
    const dir = join(parent, name);
    if (dir === own) continue;
    const meta = readJson(join(dir, 'meta.json'));
    if (typeof meta?.headSha !== 'string' || typeof meta.finishedAt !== 'string') continue;
    if (meta.headSha === job.headSha) continue;
    // Local reviews of different branches share a folder; only the same branch's history counts.
    if (isLocal(job) && meta.headRef !== job.headRef) continue;
    candidates.push({ finishedAt: meta.finishedAt, headSha: meta.headSha, dir });
  }
  // Newest first; a review where every reviewer failed is passed over for the one before it.
  for (const c of candidates.toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt))) {
    const findings = readFindings(c.dir, { carried: true });
    if (findings) return { headSha: c.headSha, findings };
  }
  return null;
}

/**
 * Pairs each finding of the new review with the prior finding it repeats, each prior finding taken at most once.
 * The pairs most alike in title are taken first across the whole list, then the ones that only share a spot, so a
 * spot-only pair never takes a prior finding away from the new finding that repeats its title. One matcher for the
 * comment and the scorecard, so they agree on what was repeated.
 */
export function matchFindings<P extends Finding, N extends Finding>(prior: P[], next: N[]): Map<N, P> {
  const pairs: { p: P; n: N; alike: number }[] = [];
  for (const n of next) {
    for (const p of prior) if (sameFinding(p, n)) pairs.push({ p, n, alike: titleSimilarity(p.title, n.title) });
  }
  // Most alike first; among spot-only pairs, the nearer first. Independent of the order either list came in.
  pairs.sort((a, b) => b.alike - a.alike || distance(a.p, a.n) - distance(b.p, b.n));
  const taken = new Set<P>();
  const matches = new Map<N, P>();
  for (const { p, n } of pairs) {
    if (matches.has(n) || taken.has(p)) continue;
    matches.set(n, p);
    taken.add(p);
  }
  return matches;
}

const distance = (a: Finding, b: Finding) => Math.abs((a.line ?? 0) - (b.line ?? 0));

/**
 * Marks each merged finding `new` or `open` against the prior review, carrying over the commit an open one has been
 * open since, and lists the prior findings nothing matched as fixed. Each prior finding matches at most one new one,
 * the most alike by title. A prior finding is fixed only when a reviewer that reported it is among `ok`, the
 * reviewers that succeeded this time: one whose reviewers all failed or didn't run says nothing either way, so it is
 * carried forward unjudged, open since the same commit. Without a prior review nothing is marked.
 */
export function trackFindings(
  headSha: string,
  findings: MergedFinding[],
  prior: PriorReview | null,
  ok: string[],
): TrackedReport {
  if (!prior) return { headSha, prior: null, findings, fixed: [] };
  const matches = matchFindings(prior.findings, findings);
  const tracked: TrackedFinding[] = findings.map((f) => {
    const match = matches.get(f);
    if (!match) return { ...f, status: 'new' };
    return { ...f, status: 'open', since: match.since ?? prior.headSha };
  });
  const matched = new Set(matches.values());
  const unmatched = prior.findings.filter((p) => !matched.has(p));
  const judged = (p: TrackedFinding) => p.reviewers.some((r) => ok.includes(r));
  const fixed = unmatched
    .filter(judged)
    .map(({ severity, dimension, file, line, title, reviewers, since, lastSeen }): FixedFinding => ({
      severity,
      ...(dimension ? { dimension } : {}),
      file,
      line,
      title,
      reviewers,
      since: since ?? prior.headSha,
      lastSeen: lastSeen ?? prior.headSha,
    }));
  const carried = unmatched
    .filter((p) => !judged(p))
    .map((p): TrackedFinding => ({
      ...p,
      status: 'open',
      since: p.since ?? prior.headSha,
      lastSeen: p.lastSeen ?? prior.headSha,
    }));
  return { headSha, prior: prior.headSha, findings: tracked, fixed, ...(carried.length ? { carried } : {}) };
}
