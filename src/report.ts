import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeStats, type DiffStats } from './diffstats.ts';
import type { RouteChoice } from './routes.ts';
import type { FixedFinding, TrackedFinding, TrackedReport } from './lifecycle.ts';
import { isLocal, type JobSource, type ResolvedJob, type ReviewerResult } from './types.ts';
import {
  DIMENSION_LABELS,
  DIMENSION_NAMES,
  DIMENSIONS,
  mergeFindings,
  type Finding,
  type Severity,
} from './verdict.ts';

export const COMMENT_MARKER = '<!-- review-relay -->';
const GITHUB_COMMENT_LIMIT = 65_000;

const SEVERITY_LABELS: Record<Severity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor' };

/** Lowest score across reviewers that succeeded; merge confidence is only as high as the most skeptical reviewer. */
export function combinedScore(results: ReviewerResult[]): number | null {
  const scores = results.flatMap((r) => (r.ok && r.score !== undefined ? [r.score] : []));
  return scores.length ? Math.min(...scores) : null;
}

/** The finding's place, linked at `sha`: the reviewed commit, or for a fixed finding the one it was last seen on. */
const location = (job: ResolvedJob, f: Pick<Finding, 'file' | 'line'>, sha = job.headSha) => {
  if (!f.file) return 'general';
  const label = f.line ? `${f.file}:${f.line}` : f.file;
  // A local commit may not be on GitHub yet, so it gets no link.
  if (isLocal(job)) return `\`${label}\``;
  const anchor = f.line ? `#L${f.line}` : '';
  return `[\`${label}\`](https://github.com/${job.repo}/blob/${sha}/${f.file}${anchor})`;
};

const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/**
 * The line under the headline for configs that route: the route that decided the review and why, or nothing when no
 * route matched, then each reviewer's model and effort.
 */
export function routeLine(route: RouteChoice | undefined, results: ReviewerResult[]): string {
  const models = results.map((r) => `${r.label}: ${[r.model ?? 'default model', r.effort].filter(Boolean).join(', ')}`);
  return `<sub>${[...(route ? [`Route \`${route.name}\` (${route.reason})`] : []), ...models].join(' · ')}</sub>`;
}

export interface CommentOptions {
  /** The route line, for configs that route. */
  routing?: string;
  /** The merged findings tracked against the prior review; merged here when unset. */
  tracked?: TrackedReport;
}

const short = (sha: string) => sha.slice(0, 8);

/** `Major · consensus`: the severity, and how many reviewers agree when more than one ran and reported it. */
const badge = (f: TrackedFinding) =>
  `**${SEVERITY_LABELS[f.severity]}${f.agreement && f.agreement !== 'single' ? ` · ${f.agreement}` : ''}**`;

/** `2 new · 1 still open · 3 fixed`, under the findings heading when a prior review exists. */
export function lifecycleLine(tracked: TrackedReport): string | undefined {
  if (!tracked.prior) return undefined;
  const open = tracked.findings.filter((f) => f.status === 'open').length;
  const fresh = tracked.findings.length - open;
  const parts = [`${fresh} new`, `${open} still open`, `${tracked.fixed.length} fixed`];
  return `<sub>Since \`${short(tracked.prior)}\`: ${parts.join(' · ')}</sub>`;
}

/** A fixed finding, linked at the commit it was last reported on, where its line still exists. */
const fixedLine = (job: ResolvedJob, labels: Map<string, string>, f: FixedFinding) =>
  `- ~~${SEVERITY_LABELS[f.severity]} ${location(job, f, f.lastSeen)}: ${escapeCell(f.title)}~~ _(${f.reviewers
    .map((id) => labels.get(id) ?? id)
    .join(', ')}, open since \`${short(f.since)}\`)_`;

export function commentBody(
  job: ResolvedJob,
  results: ReviewerResult[],
  stats: DiffStats,
  opts: CommentOptions = {},
): string {
  const ok = results.filter((r) => r.ok && r.verdict);
  const overall = combinedScore(results);
  const lines: string[] = [COMMENT_MARKER];
  const routing = opts.routing;

  lines.push(`## review-relay: Confidence ${overall ?? '?'}/5`);
  const perReviewer = results.map((r) => `${r.label} ${r.ok ? `${r.score}/5` : 'failed'}`).join(', ');
  lines.push(
    // A <br> keeps the routing line on a line of its own; GitHub joins adjacent lines into one.
    `<sub>Commit \`${short(job.headSha)}\` · ${job.reason} · ${describeStats(stats)} · lowest of: ${perReviewer}</sub>${routing ? '<br>' : ''}`,
    ...(routing ? [routing] : []),
    '',
  );

  for (const r of ok) lines.push(`**${r.label}:** ${r.verdict!.summary} _${r.verdict!.scoreRationale}_`, '');

  lines.push(
    `| | ${results.map((r) => escapeCell(r.label)).join(' | ')} |`,
    `|---|${results.map(() => ':-:').join('|')}|`,
  );
  lines.push(`| **Overall** | ${results.map((r) => (r.ok ? `**${r.score}/5**` : 'failed')).join(' | ')} |`);
  for (const d of DIMENSIONS) {
    lines.push(
      `| ${DIMENSION_LABELS[d]} | ${results.map((r) => (r.verdict ? `${r.verdict.dimensions[d].score}` : '-')).join(' | ')} |`,
    );
  }
  lines.push('');

  // Merged by id, so two reviewers on one CLI count as two reviewers; shown by label.
  const tracked: TrackedReport = opts.tracked ?? {
    headSha: job.headSha,
    prior: null,
    findings: mergeFindings(ok.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings }))),
    fixed: [],
  };
  const findings = tracked.findings;
  const labels = new Map(results.map((r) => [r.name, r.label]));
  const label = (id: string) => labels.get(id) ?? id;
  lines.push(`### Findings (${findings.length})`, '');
  const lifecycle = lifecycleLine(tracked);
  if (lifecycle) lines.push(lifecycle, '');
  if (findings.length === 0) lines.push('No issues found.', '');
  for (const f of findings) {
    const who = [f.reviewers.map(label).join(', '), f.dimension && DIMENSION_NAMES[f.dimension]].filter(Boolean);
    const status =
      f.status === 'open' ? ` · open since \`${short(f.since ?? '')}\`` : f.status === 'new' ? ' · new' : '';
    lines.push(
      `- ${badge(f)} ${location(job, f)}: ${escapeCell(f.title)} _(${who.join(' · ')})_${status}`,
      `  <details><summary>Details</summary>`,
      '',
      `  ${f.detail.replace(/\n/g, '\n  ')}`,
      '',
      `  **Suggested fix:** ${f.suggestion.replace(/\n/g, '\n  ')}`,
      '',
      '  </details>',
    );
  }
  lines.push('');
  if (tracked.fixed.length > 0) {
    lines.push(
      `<details><summary>Fixed since \`${short(tracked.prior!)}\` (${tracked.fixed.length})</summary>`,
      '',
      ...tracked.fixed.map((f) => fixedLine(job, labels, f)),
      '',
      '</details>',
      '',
    );
  }

  lines.push('<details><summary>Dimension notes</summary>', '');
  for (const r of ok) {
    lines.push(`**${r.label}**`, '');
    for (const d of DIMENSIONS)
      lines.push(`- ${DIMENSION_LABELS[d]} (${r.verdict!.dimensions[d].score}/5): ${r.verdict!.dimensions[d].note}`);
    lines.push('');
  }
  lines.push('</details>', '');

  for (const res of results.filter((f) => !f.ok))
    lines.push(`> ${res.label} review failed: ${escapeCell((res.error ?? '').slice(0, 300))}`, '');

  lines.push(
    '<sub>Scores are 1-5 merge confidence. Caps: a critical finding limits a reviewer to 2/5, a major finding to 3/5, and no overall score exceeds the weakest dimension by more than 1.</sub>',
  );

  const body = lines.join('\n');
  return body.length > GITHUB_COMMENT_LIMIT ? `${body.slice(0, GITHUB_COMMENT_LIMIT - 40)}\n\n_(truncated)_` : body;
}

/** Where a job's report lives: one folder per PR commit, or under `local/` for a local review. */
export const reportDirFor = (dataDir: string, job: { repo: string; pr: number; headSha: string; source?: JobSource }) =>
  join(
    dataDir,
    'reports',
    job.repo.replace('/', '__'),
    isLocal(job) ? 'local' : `pr-${job.pr}`,
    job.headSha.slice(0, 8),
  );

export async function writeReport(
  dataDir: string,
  job: ResolvedJob,
  results: ReviewerResult[],
  comment: string,
  route?: RouteChoice,
  tracked?: TrackedReport,
): Promise<string> {
  const dir = reportDirFor(dataDir, job);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'comment.md'), `${comment}\n`);
  if (tracked) await Bun.write(join(dir, 'findings.json'), JSON.stringify(tracked, null, 2));
  for (const r of results) {
    await Bun.write(
      join(dir, `${r.name}.json`),
      JSON.stringify(r.ok ? { score: r.score, verdict: r.verdict } : { error: r.error, output: r.output }, null, 2),
    );
  }
  await Bun.write(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        ...job,
        finishedAt: new Date().toISOString(),
        score: combinedScore(results),
        route: route ?? null,
        reviewers: results.map(
          ({ name, harness, model, effort, provider, timeoutMs, ok, score, error, durationMs, usage }) => ({
            name,
            harness,
            model,
            effort,
            provider,
            timeoutMs,
            ok,
            score,
            error,
            durationMs,
            usage,
          }),
        ),
      },
      null,
      2,
    ),
  );
  return dir;
}
