import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeStats, type DiffStats } from './diffstats.ts';
import type { RouteChoice } from './routes.ts';
import type { ResolvedJob, ReviewerResult } from './types.ts';
import { DIMENSION_LABELS, DIMENSIONS, mergeFindings, type MergedFinding, type Severity } from './verdict.ts';

export const COMMENT_MARKER = '<!-- review-relay -->';
const GITHUB_COMMENT_LIMIT = 65_000;

const SEVERITY_LABELS: Record<Severity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor' };

/** Lowest score across reviewers that succeeded; merge confidence is only as high as the most skeptical reviewer. */
export function combinedScore(results: ReviewerResult[]): number | null {
  const scores = results.flatMap((r) => (r.ok && r.score !== undefined ? [r.score] : []));
  return scores.length ? Math.min(...scores) : null;
}

const location = (job: ResolvedJob, f: MergedFinding) => {
  if (!f.file) return 'general';
  const label = f.line ? `${f.file}:${f.line}` : f.file;
  const anchor = f.line ? `#L${f.line}` : '';
  return `[\`${label}\`](https://github.com/${job.repo}/blob/${job.headSha}/${f.file}${anchor})`;
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

export function commentBody(job: ResolvedJob, results: ReviewerResult[], stats: DiffStats, routing?: string): string {
  const ok = results.filter((r) => r.ok && r.verdict);
  const overall = combinedScore(results);
  const lines: string[] = [COMMENT_MARKER];

  lines.push(`## review-relay: Confidence ${overall ?? '?'}/5`);
  const perReviewer = results.map((r) => `${r.label} ${r.ok ? `${r.score}/5` : 'failed'}`).join(', ');
  lines.push(
    // A <br> keeps the routing line on a line of its own; GitHub joins adjacent lines into one.
    `<sub>Commit \`${job.headSha.slice(0, 8)}\` · ${job.reason} · ${describeStats(stats)} · lowest of: ${perReviewer}</sub>${routing ? '<br>' : ''}`,
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
  const findings = mergeFindings(ok.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings })));
  const labels = new Map(results.map((r) => [r.name, r.label]));
  lines.push(`### Findings (${findings.length})`, '');
  if (findings.length === 0) lines.push('No issues found.', '');
  for (const f of findings) {
    lines.push(
      `- **${SEVERITY_LABELS[f.severity]}** ${location(job, f)}: ${escapeCell(f.title)} _(${f.reviewers.map((id) => labels.get(id)).join(', ')})_`,
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

export const reportDirFor = (dataDir: string, job: { repo: string; pr: number; headSha: string }) =>
  join(dataDir, 'reports', job.repo.replace('/', '__'), `pr-${job.pr}`, job.headSha.slice(0, 8));

export async function writeReport(
  dataDir: string,
  job: ResolvedJob,
  results: ReviewerResult[],
  comment: string,
  route?: RouteChoice,
): Promise<string> {
  const dir = reportDirFor(dataDir, job);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'comment.md'), `${comment}\n`);
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
          ({ name, harness, model, effort, provider, timeoutMs, ok, score, error, durationMs }) => ({
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
          }),
        ),
      },
      null,
      2,
    ),
  );
  return dir;
}
