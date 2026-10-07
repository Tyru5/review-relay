import type { GithubTriggerConfig } from './config.ts';
import type { Bot, ReviewJob } from './types.ts';

export const GREPTILE_APP_SLUG = 'greptile-apps';
export const GREPTILE_CHECK_NAME = 'Greptile Review';

export const CODERABBIT_APP_SLUG = 'coderabbitai';
export const CODERABBIT_BOT = 'coderabbitai[bot]';
/** Context of CodeRabbit's commit status, which it sets to `pending` / `Review in progress` once a review starts. */
export const CODERABBIT_STATUS_CONTEXT = 'CodeRabbit';
export const CODERABBIT_STATUS_STARTED = 'Review in progress';

export const BOT_NAMES: Record<Bot, string> = { greptile: 'Greptile', coderabbit: 'CodeRabbit' };

/**
 * A review bot started on a commit. A commit status names no PR, so `pr` is unset until the scheduler finds the open PR
 * whose head is `headSha`.
 */
export type BotStartJob = Omit<ReviewJob, 'pr' | 'source' | 'headSha'> & { pr?: number; source: Bot; headSha: string };

export type Classified =
  | { kind: 'botStart'; job: BotStartJob }
  | { kind: 'botDone'; bot: Bot; repo: string; headSha: string; result: string | null }
  | { kind: 'prEvent'; job: ReviewJob }
  | { kind: 'mention'; job: ReviewJob }
  | { kind: 'ignore'; reason: string };

const PR_OPEN_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const ignore = (reason: string): Classified => ({ kind: 'ignore', reason });

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classify(event: string, payload: any, github: GithubTriggerConfig): Classified {
  const repo: string | undefined = payload?.repository?.full_name;
  if (!repo) return ignore(`${event}: no repository`);

  switch (event) {
    case 'check_run':
      return payload.check_run?.app?.slug === CODERABBIT_APP_SLUG
        ? classifyCodeRabbitCheckRun(repo, payload)
        : classifyCheckRun(repo, payload);
    case 'status':
      return classifyStatus(repo, payload);
    case 'pull_request':
      return classifyPullRequest(repo, payload, github);
    case 'issue_comment':
      return classifyComment(repo, payload, github);
    default:
      return ignore(`unhandled event ${event}`);
  }
}

function classifyCheckRun(repo: string, payload: any): Classified {
  const run = payload.check_run;
  if (run?.app?.slug !== GREPTILE_APP_SLUG || run?.name !== GREPTILE_CHECK_NAME) {
    return ignore(`check_run from ${run?.app?.slug ?? 'unknown'} (${run?.name ?? '?'})`);
  }
  if (payload.action === 'completed') {
    return {
      kind: 'botDone',
      bot: 'greptile',
      repo,
      headSha: run.head_sha,
      result: run.output?.title ?? run.conclusion ?? null,
    };
  }
  if (payload.action !== 'created' || (run.status !== 'in_progress' && run.status !== 'queued')) {
    return ignore(`greptile check_run ${payload.action}/${run.status}`);
  }
  // Fork PRs arrive with an empty `pull_requests` list; auto mode's GitHub fallback covers them.
  const pr = run.pull_requests?.[0];
  if (!pr) return ignore('greptile check_run without an associated PR');
  return {
    kind: 'botStart',
    job: {
      repo,
      pr: pr.number,
      source: 'greptile',
      reason: `Greptile started (${run.output?.title ?? 'review'})`,
      headSha: run.head_sha,
      headRef: pr.head?.ref ?? run.check_suite?.head_branch,
      baseRef: pr.base?.ref,
    },
  };
}

/**
 * CodeRabbit's check run, which its docs say replaces the commit status when `reviews.review_progress` is on. The docs
 * don't name the check, so any CodeRabbit check counts except the opt-in `CodeRabbit Security` merge gate.
 */
function classifyCodeRabbitCheckRun(repo: string, payload: any): Classified {
  const run = payload.check_run;
  if (/security/i.test(run?.name ?? '')) return ignore(`coderabbit check_run ${run.name}`);
  if (payload.action === 'completed') {
    return {
      kind: 'botDone',
      bot: 'coderabbit',
      repo,
      headSha: run.head_sha,
      result: run.output?.title ?? run.conclusion ?? null,
    };
  }
  if (payload.action !== 'created' || (run.status !== 'in_progress' && run.status !== 'queued')) {
    return ignore(`coderabbit check_run ${payload.action}/${run.status}`);
  }
  // Fork PRs arrive with an empty `pull_requests` list; the scheduler looks the PR up by head commit instead.
  const pr = run.pull_requests?.[0];
  return {
    kind: 'botStart',
    job: {
      repo,
      ...(pr ? { pr: pr.number, headRef: pr.head?.ref, baseRef: pr.base?.ref } : {}),
      source: 'coderabbit',
      reason: `CodeRabbit started (${run.output?.title ?? run.name ?? 'review'})`,
      headSha: run.head_sha,
    },
  };
}

/**
 * CodeRabbit's commit status: `Review queued`, then `Review in progress`, then `success` with `Review completed`, or
 * `success` right away with `Review skipped: ...` for a PR it won't review. Only `Review in progress` starts a review.
 */
function classifyStatus(repo: string, payload: any): Classified {
  if (payload.context !== CODERABBIT_STATUS_CONTEXT) return ignore(`status ${payload.context ?? '?'}`);
  // Anyone with push access can set a status, so the context alone doesn't prove CodeRabbit set it.
  if (payload.sender?.login !== CODERABBIT_BOT) {
    return ignore(`status ${payload.context} from ${payload.sender?.login ?? 'unknown'}, not ${CODERABBIT_BOT}`);
  }
  const sha: string | undefined = payload.sha;
  if (!sha) return ignore('coderabbit status without a commit');
  if (payload.state !== 'pending') {
    return { kind: 'botDone', bot: 'coderabbit', repo, headSha: sha, result: payload.description ?? payload.state };
  }
  if (payload.description !== CODERABBIT_STATUS_STARTED) {
    return ignore(`coderabbit status pending/${payload.description ?? '?'}`);
  }
  return {
    kind: 'botStart',
    job: { repo, source: 'coderabbit', reason: `CodeRabbit started (${payload.description})`, headSha: sha },
  };
}

function classifyPullRequest(repo: string, payload: any, github: GithubTriggerConfig): Classified {
  const pr = payload.pull_request;
  const action: string = payload.action;
  const wanted = PR_OPEN_ACTIONS.has(action) || (action === 'synchronize' && github.onPush);
  if (!wanted) return ignore(`pull_request ${action}`);
  if (pr?.state !== 'open') return ignore(`pull_request ${action} on ${pr?.state ?? 'unknown'} PR`);
  if (pr.draft) return ignore(`pull_request ${action} on draft`);
  return {
    kind: 'prEvent',
    job: {
      repo,
      pr: pr.number,
      source: 'github',
      reason: `pull_request ${action}`,
      headSha: pr.head?.sha,
      headRef: pr.head?.ref,
      baseRef: pr.base?.ref,
      ...(pr.user?.login ? { author: pr.user.login } : {}),
    },
  };
}

function classifyComment(repo: string, payload: any, github: GithubTriggerConfig): Classified {
  const comment = payload.comment;
  if (payload.action !== 'created') return ignore(`issue_comment ${payload.action}`);
  if (!payload.issue?.pull_request) return ignore('issue_comment on an issue, not a PR');
  if (comment?.user?.type === 'Bot') return ignore('issue_comment from a bot');
  const body = String(comment?.body ?? '').toLowerCase();
  if (!body.includes(github.mention.toLowerCase())) return ignore('issue_comment without mention');
  if (!TRUSTED_ASSOCIATIONS.has(comment?.author_association)) {
    return ignore(`mention from untrusted ${comment?.author_association ?? 'unknown'} user`);
  }
  // The word after the mention may name a route, as in "@review-relay risky"; routing decides whether it does.
  const word = new RegExp(`${escapeRegExp(github.mention.toLowerCase())}\\s+([a-z0-9][a-z0-9-]*)`).exec(body)?.[1];
  const login: string | undefined = comment.user?.login;
  return {
    kind: 'mention',
    job: {
      repo,
      pr: payload.issue.number,
      source: 'mention',
      reason: `${github.mention} from ${login ?? 'unknown'}`,
      ...(word ? { route: word } : {}),
      ...(login ? { requestedBy: login } : {}),
    },
  };
}
