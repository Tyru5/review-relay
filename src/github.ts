import { execOrThrow } from './exec.ts';
import type { ResolvedJob, ReviewJob } from './types.ts';

/** Fills in head SHA and refs from GitHub for triggers whose payload lacks them. */
export async function resolveJob(job: ReviewJob): Promise<ResolvedJob> {
  const out = await execOrThrow([
    'gh', 'pr', 'view', String(job.pr), '--repo', job.repo,
    '--json', 'headRefOid,headRefName,baseRefName,state',
  ]);
  const pr = JSON.parse(out) as { headRefOid: string; headRefName: string; baseRefName: string; state: string };
  if (pr.state !== 'OPEN') throw new Error(`PR #${job.pr} is ${pr.state.toLowerCase()}`);
  return { ...job, headSha: pr.headRefOid, headRef: pr.headRefName, baseRef: pr.baseRefName };
}

export async function postComment(repo: string, pr: number, body: string): Promise<void> {
  await execOrThrow(['gh', 'pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], { stdin: body });
}
