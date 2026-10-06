import { execOrThrow } from './exec.ts';
import { COMMENT_MARKER } from './report.ts';
import type { CommitPr } from './scheduler.ts';
import type { ResolvedJob, ReviewJob } from './types.ts';

/** Fills in head SHA and refs from GitHub for triggers whose payload lacks them. `open: false` takes a closed PR too. */
export async function resolveJob(job: ReviewJob, { open = true } = {}): Promise<ResolvedJob> {
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
  if (open && pr.state !== 'OPEN') throw new Error(`PR #${job.pr} is ${pr.state.toLowerCase()}`);
  return { ...job, headSha: pr.headRefOid, headRef: pr.headRefName, baseRef: pr.baseRefName };
}

/**
 * The open, non-draft PR whose head is `sha`, for a commit status, which names no PR. Lists open PRs rather than asking
 * `commits/{sha}/pulls`, which misses fresh fork PRs.
 */
export async function openPrForCommit(repo: string, sha: string): Promise<CommitPr | null> {
  const out = await execOrThrow([
    'gh',
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,headRefOid,headRefName,baseRefName,isDraft',
  ]);
  const prs = JSON.parse(out) as {
    number: number;
    headRefOid: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  }[];
  const pr = prs.find((p) => p.headRefOid === sha && !p.isDraft);
  return pr ? { pr: pr.number, headRef: pr.headRefName, baseRef: pr.baseRefName } : null;
}

/** The PR's head commit on GitHub right now, which decides whether a review is still current. */
export async function prHead(repo: string, pr: number): Promise<string> {
  return (await execOrThrow(['gh', 'api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'])).trim();
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
