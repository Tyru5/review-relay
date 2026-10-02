import type { GithubTriggerConfig } from './config.ts';
import type { ReviewJob } from './types.ts';

export const GREPTILE_APP_SLUG = 'greptile-apps';
export const GREPTILE_CHECK_NAME = 'Greptile Review';

export type Classified =
  | { kind: 'greptileStart'; job: ReviewJob }
  | { kind: 'greptileDone'; repo: string; headSha: string; conclusion: string | null; title: string | null }
  | { kind: 'prEvent'; job: ReviewJob }
  | { kind: 'mention'; job: ReviewJob }
  | { kind: 'ignore'; reason: string };

const PR_OPEN_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const ignore = (reason: string): Classified => ({ kind: 'ignore', reason });

export function classify(event: string, payload: any, github: GithubTriggerConfig): Classified {
  const repo: string | undefined = payload?.repository?.full_name;
  if (!repo) return ignore(`${event}: no repository`);

  switch (event) {
    case 'check_run':
      return classifyCheckRun(repo, payload);
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
      kind: 'greptileDone',
      repo,
      headSha: run.head_sha,
      conclusion: run.conclusion ?? null,
      title: run.output?.title ?? null,
    };
  }
  if (payload.action !== 'created' || (run.status !== 'in_progress' && run.status !== 'queued')) {
    return ignore(`greptile check_run ${payload.action}/${run.status}`);
  }
  // Fork PRs arrive with an empty `pull_requests` list; auto mode's GitHub fallback covers them.
  const pr = run.pull_requests?.[0];
  if (!pr) return ignore('greptile check_run without an associated PR');
  return {
    kind: 'greptileStart',
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
  return {
    kind: 'mention',
    job: {
      repo,
      pr: payload.issue.number,
      source: 'mention',
      reason: `${github.mention} from ${comment.user?.login ?? 'unknown'}`,
    },
  };
}
