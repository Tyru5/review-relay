import { execOrThrow } from './exec.ts';
import { COMMENT_MARKER } from './report.ts';
import type { ResolvedJob, ReviewJob } from './types.ts';

/** Fills in head SHA and refs from GitHub for triggers whose payload lacks them. */
export async function resolveJob(job: ReviewJob): Promise<ResolvedJob> {
  const out = await execOrThrow([
    'gh',
    'pr',
    'view',
    String(job.pr),
    '--repo',
    job.repo,
    '--json',
    'headRefOid,headRefName,baseRefName,state',
  ]);
  const pr = JSON.parse(out) as { headRefOid: string; headRefName: string; baseRefName: string; state: string };
  if (pr.state !== 'OPEN') throw new Error(`PR #${job.pr} is ${pr.state.toLowerCase()}`);
  return { ...job, headSha: pr.headRefOid, headRef: pr.headRefName, baseRef: pr.baseRefName };
}

/** Keeps one relay comment per PR: edits the signed-in user's marked comment, or creates it. */
export async function upsertComment(repo: string, pr: number, body: string): Promise<void> {
  const login = (await execOrThrow(['gh', 'api', 'user', '--jq', '.login'])).trim();
  const ids = await execOrThrow([
    'gh',
    'api',
    '--paginate',
    `repos/${repo}/issues/${pr}/comments`,
    '--jq',
    `.[] | select(.user.login == "${login}" and (.body | contains("${COMMENT_MARKER}"))) | .id`,
  ]);
  const existing = ids
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  const payload = JSON.stringify({ body });
  if (existing) {
    await execOrThrow(['gh', 'api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '--input', '-'], {
      stdin: payload,
    });
  } else {
    await execOrThrow(['gh', 'api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], {
      stdin: payload,
    });
  }
}
