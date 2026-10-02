import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedJob, ReviewerResult } from './types.ts';

export const COMMENT_MARKER = '<!-- review-relay -->';
const GITHUB_COMMENT_LIMIT = 65_000;

const LABELS = { codex: 'Codex', claude: 'Claude' } as const;

export async function writeReport(dataDir: string, job: ResolvedJob, results: ReviewerResult[]): Promise<string> {
  const dir = join(dataDir, 'reports', job.repo.replace('/', '__'), `pr-${job.pr}`, job.headSha.slice(0, 8));
  await mkdir(dir, { recursive: true });
  for (const r of results) {
    await Bun.write(join(dir, `${r.name}.md`), r.ok ? `${r.output}\n` : `Review failed: ${r.error}\n\n${r.output}\n`);
  }
  await Bun.write(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        ...job,
        finishedAt: new Date().toISOString(),
        reviewers: results.map(({ name, ok, error, durationMs }) => ({ name, ok, error, durationMs })),
      },
      null,
      2,
    ),
  );
  return dir;
}

export function commentBody(job: ResolvedJob, results: ReviewerResult[]): string {
  const header = `${COMMENT_MARKER}\n### Local AI review for \`${job.headSha.slice(0, 8)}\`\n\nTriggered by: ${job.reason}\n`;
  const budget = Math.floor((GITHUB_COMMENT_LIMIT - header.length) / Math.max(results.length, 1)) - 200;
  const sections = results.map((r) => {
    const text = r.ok ? r.output : `Review failed: ${r.error}`;
    const body = text.length > budget ? `${text.slice(0, budget)}\n\n_(truncated)_` : text;
    return `<details open>\n<summary>${LABELS[r.name]} (${Math.round(r.durationMs / 1000)}s)</summary>\n\n${body}\n\n</details>`;
  });
  return [header, ...sections].join('\n\n');
}
