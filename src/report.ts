import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeStats, type DiffStats } from './diffstats.ts';
import { HARNESSES } from './reviewers/index.ts';
import type { ResolvedJob, ReviewerName, ReviewerResult } from './types.ts';
import { DIMENSION_LABELS, DIMENSIONS, mergeFindings, type MergedFinding, type Severity } from './verdict.ts';

export const COMMENT_MARKER = '<!-- review-relay -->';
const GITHUB_COMMENT_LIMIT = 65_000;

const reviewerLabel = (name: ReviewerName) => HARNESSES[name].label;
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

export function commentBody(job: ResolvedJob, results: ReviewerResult[], stats: DiffStats): string {
  const ok = results.filter((r) => r.ok && r.verdict);
  const overall = combinedScore(results);
  const lines: string[] = [COMMENT_MARKER];

  lines.push(`## review-relay: Confidence ${overall ?? '?'}/5`);
  const perReviewer = results.map((r) => `${reviewerLabel(r.name)} ${r.ok ? `${r.score}/5` : 'failed'}`).join(', ');
  lines.push(
    `<sub>Commit \`${job.headSha.slice(0, 8)}\` · ${job.reason} · ${describeStats(stats)} · lowest of: ${perReviewer}</sub>`,
    '',
  );

  for (const r of ok)
    lines.push(`**${reviewerLabel(r.name)}:** ${r.verdict!.summary} _${r.verdict!.scoreRationale}_`, '');

  lines.push(
    `| | ${results.map((r) => reviewerLabel(r.name)).join(' | ')} |`,
    `|---|${results.map(() => ':-:').join('|')}|`,
  );
  lines.push(`| **Overall** | ${results.map((r) => (r.ok ? `**${r.score}/5**` : 'failed')).join(' | ')} |`);
  for (const d of DIMENSIONS) {
    lines.push(
      `| ${DIMENSION_LABELS[d]} | ${results.map((r) => (r.verdict ? `${r.verdict.dimensions[d].score}` : '-')).join(' | ')} |`,
    );
  }
  lines.push('');

  const findings = mergeFindings(ok.map((r) => ({ reviewer: reviewerLabel(r.name), findings: r.verdict!.findings })));
  lines.push(`### Findings (${findings.length})`, '');
  if (findings.length === 0) lines.push('No issues found.', '');
  for (const f of findings) {
    lines.push(
      `- **${SEVERITY_LABELS[f.severity]}** ${location(job, f)}: ${escapeCell(f.title)} _(${f.reviewers.join(', ')})_`,
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
    lines.push(`**${reviewerLabel(r.name)}**`, '');
    for (const d of DIMENSIONS)
      lines.push(`- ${DIMENSION_LABELS[d]} (${r.verdict!.dimensions[d].score}/5): ${r.verdict!.dimensions[d].note}`);
    lines.push('');
  }
  lines.push('</details>', '');

  for (const res of results.filter((f) => !f.ok))
    lines.push(`> ${reviewerLabel(res.name)} review failed: ${escapeCell((res.error ?? '').slice(0, 300))}`, '');

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
        reviewers: results.map(({ name, ok, score, error, durationMs }) => ({ name, ok, score, error, durationMs })),
      },
      null,
      2,
    ),
  );
  return dir;
}
