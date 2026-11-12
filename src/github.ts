import { execOrThrow } from './exec.ts';
import { INLINE_MARKER, unposted, type InlineComment, type PostedComment } from './inline.ts';
import { COMMENT_MARKER } from './report.ts';
import type { CommitPr } from './scheduler.ts';
import type { ResolvedJob, ReviewJob } from './types.ts';

export type PrState = 'open' | 'closed' | 'merged';

/** GitHub distinguishes a merged PR from one closed without merging. */
export async function prState(repo: string, pr: number, signal?: AbortSignal): Promise<PrState> {
  const out = await execOrThrow(['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'state', '--jq', '.state'], {
    timeoutMs: 10_000,
    signal,
  });
  const state = out.trim().toLowerCase();
  if (state !== 'open' && state !== 'closed' && state !== 'merged') throw new Error('unknown PR state');
  return state;
}

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

/** The PR author's login, as webhooks write it (`dependabot[bot]` for an app). */
export async function prAuthor(repo: string, pr: number): Promise<string> {
  return (await execOrThrow(['gh', 'api', `repos/${repo}/pulls/${pr}`, '--jq', '.user.login'])).trim();
}

const signedInLogin = async () => (await execOrThrow(['gh', 'api', 'user', '--jq', '.login'])).trim();

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

/** Sets the `review-relay` commit status, with the description cut to GitHub's 140 characters. */
export async function setCommitStatus(
  repo: string,
  sha: string,
  status: { state: CommitState; description: string; targetUrl?: string },
): Promise<void> {
  const payload = JSON.stringify({
    state: status.state,
    context: 'review-relay',
    description: status.description.length > 140 ? `${status.description.slice(0, 139)}…` : status.description,
    ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
  });
  await execOrThrow(['gh', 'api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '--input', '-'], {
    stdin: payload,
    timeoutMs: 30_000,
  });
}

/**
 * Posts the comments as one `COMMENT` review on `sha`, leaving out the spots the signed-in user's earlier inline
 * comments already cover on that commit. Returns how many it posted; none posts no review.
 */
export async function postInlineReview(
  repo: string,
  pr: number,
  sha: string,
  body: string,
  comments: InlineComment[],
): Promise<number> {
  const login = await signedInLogin();
  const out = await execOrThrow([
    'gh',
    'api',
    '--paginate',
    `repos/${repo}/pulls/${pr}/comments`,
    '--jq',
    `.[] | select(.user.login == "${login}" and (.body | contains("${INLINE_MARKER}"))) | {path, original_line, original_commit_id}`,
  ]);
  const posted = out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PostedComment);
  const fresh = unposted(comments, posted, sha);
  if (fresh.length === 0) return 0;
  await execOrThrow(['gh', 'api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], {
    stdin: JSON.stringify({ commit_id: sha, event: 'COMMENT', body, comments: fresh }),
  });
  return fresh.length;
}

/** Keeps one relay comment per PR: edits the signed-in user's marked comment, or creates it. Returns its URL. */
export async function upsertComment(repo: string, pr: number, body: string): Promise<string> {
  const login = await signedInLogin();
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
  const url = existing
    ? await execOrThrow(
        ['gh', 'api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '--input', '-', '--jq', '.html_url'],
        { stdin: payload },
      )
    : await execOrThrow(
        ['gh', 'api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-', '--jq', '.html_url'],
        { stdin: payload },
      );
  return url.trim();
}
