import { describe, expect, test } from 'bun:test';
import { classify } from '../src/match.ts';
import checkCreated from './fixtures/greptile-check-run-created.json';
import checkCompleted from './fixtures/greptile-check-run-completed.json';
import pullRequest from './fixtures/pull-request.json';
import issueComment from './fixtures/issue-comment.json';
import coderabbitStatus from './fixtures/coderabbit-status-in-progress.json';
import coderabbitCheck from './fixtures/coderabbit-check-run-created.json';

const github = { onPush: false, mention: '@review-relay' };
const clone = <T>(v: T): T => structuredClone(v);

describe('Greptile check_run', () => {
  test('created + in_progress is a start with PR, head SHA and base ref', () => {
    const result = classify('check_run', checkCreated, github);
    expect(result).toEqual({
      kind: 'botStart',
      job: {
        repo: 'Tyru5/Agendex',
        pr: 223,
        source: 'greptile',
        reason: 'Greptile started (Apex review)',
        headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
        headRef: 'feat/cloud-obfuscation-security-spike',
        baseRef: 'main',
      },
    });
  });

  test('completed is a done event regardless of conclusion', () => {
    const result = classify('check_run', checkCompleted, github);
    expect(result).toEqual({
      kind: 'botDone',
      bot: 'greptile',
      repo: 'Tyru5/Agendex',
      headSha: checkCompleted.check_run.head_sha,
      result: 'Apex review: Confidence 0/5 — below your required 5/5',
    });
  });

  test('other apps and check names are ignored', () => {
    const actions = clone(checkCreated);
    actions.check_run.app.slug = 'github-actions';
    actions.check_run.name = 'verify';
    expect(classify('check_run', actions, github).kind).toBe('ignore');

    const renamed = clone(checkCreated);
    renamed.check_run.name = 'Something Else';
    expect(classify('check_run', renamed, github).kind).toBe('ignore');
  });

  test('a start without an associated PR (fork) is ignored', () => {
    const fork = clone(checkCreated);
    fork.check_run.pull_requests = [];
    expect(classify('check_run', fork, github).kind).toBe('ignore');
  });
});

describe('CodeRabbit commit status', () => {
  // The strings CodeRabbit sets, read from the statuses API on live PRs (2026-10-06).
  const status = (state: string, description: string, sender = 'coderabbitai[bot]') => ({
    ...clone(coderabbitStatus),
    state,
    description,
    sender: { login: sender, type: 'Bot' },
  });

  test('pending "Review in progress" is a start that names the commit but no PR', () => {
    expect(classify('status', coderabbitStatus, github)).toEqual({
      kind: 'botStart',
      job: {
        repo: 'Tyru5/Agendex',
        source: 'coderabbit',
        reason: 'CodeRabbit started (Review in progress)',
        headSha: '8335bfb9620209084a208e9e926c35c7d8bef13a',
      },
    });
  });

  test('"Review queued" is not a start yet: a queued review can still be skipped', () => {
    expect(classify('status', status('pending', 'Review queued'), github)).toEqual({
      kind: 'ignore',
      reason: 'coderabbit status pending/Review queued',
    });
  });

  test.each([
    ['success', 'Review completed'],
    ['success', 'Review skipped: draft pull request'],
    ['success', 'Review rate limited'],
    ['failure', 'Review failed'],
  ])('%s "%s" is a done event, never a start', (state, description) => {
    expect(classify('status', status(state, description), github)).toEqual({
      kind: 'botDone',
      bot: 'coderabbit',
      repo: 'Tyru5/Agendex',
      headSha: coderabbitStatus.sha,
      result: description,
    });
  });

  test('a CodeRabbit context set by anyone but the CodeRabbit app is ignored', () => {
    expect(classify('status', status('pending', 'Review in progress', 'mallory'), github).kind).toBe('ignore');
    expect(classify('status', status('pending', 'Review in progress', 'coderabbitai'), github).kind).toBe('ignore');
  });

  test('other status contexts are ignored', () => {
    const ci = { ...clone(coderabbitStatus), context: 'ci/build', sender: { login: 'github-actions[bot]' } };
    expect(classify('status', ci, github)).toEqual({ kind: 'ignore', reason: 'status ci/build' });
    const lookalike = { ...clone(coderabbitStatus), context: 'CodeRabbit Security' };
    expect(classify('status', lookalike, github).kind).toBe('ignore');
  });
});

describe('CodeRabbit check_run', () => {
  // Modeled on Greptile's check run: CodeRabbit's docs describe check runs but don't publish a payload or check name.
  test('created is a start with PR, head SHA and base ref', () => {
    expect(classify('check_run', coderabbitCheck, github)).toEqual({
      kind: 'botStart',
      job: {
        repo: 'Tyru5/Agendex',
        pr: 224,
        headRef: 'refactor/chainstate-sync-progress',
        baseRef: 'main',
        source: 'coderabbit',
        reason: 'CodeRabbit started (Review in progress)',
        headSha: '8335bfb9620209084a208e9e926c35c7d8bef13a',
      },
    });
  });

  test('a fork start without an associated PR still starts, by commit, unlike Greptile', () => {
    const fork = clone(coderabbitCheck);
    fork.check_run.pull_requests = [];
    const result = classify('check_run', fork, github);
    expect(result.kind).toBe('botStart');
    if (result.kind === 'botStart') {
      expect(result.job.pr).toBeUndefined();
      expect(result.job.headSha).toBe(coderabbitCheck.check_run.head_sha);
    }
  });

  test('completed is a done event; the Security merge gate is not a review', () => {
    const done = clone(coderabbitCheck) as any;
    done.action = 'completed';
    done.check_run.status = 'completed';
    done.check_run.conclusion = 'success';
    done.check_run.output.title = 'Review completed';
    expect(classify('check_run', done, github)).toMatchObject({
      kind: 'botDone',
      bot: 'coderabbit',
      result: 'Review completed',
    });

    const security = clone(coderabbitCheck);
    security.check_run.name = 'CodeRabbit Security';
    expect(classify('check_run', security, github).kind).toBe('ignore');
  });

  test('a check created already completed (a skipped review) is not a start', () => {
    const skipped = clone(coderabbitCheck) as any;
    skipped.check_run.status = 'completed';
    expect(classify('check_run', skipped, github).kind).toBe('ignore');
  });
});

describe('pull_request', () => {
  const withAction = (action: string, patch: Record<string, unknown> = {}) => {
    const p = clone(pullRequest);
    p.action = action;
    Object.assign(p.pull_request, patch);
    return p;
  };

  test.each(['opened', 'reopened', 'ready_for_review'])('%s triggers a review', (action) => {
    const result = classify('pull_request', withAction(action), github);
    expect(result.kind).toBe('prEvent');
    if (result.kind === 'prEvent') {
      expect(result.job).toMatchObject({
        pr: 223,
        source: 'github',
        headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
        baseRef: 'main',
      });
    }
  });

  test('drafts and closed PRs are skipped', () => {
    expect(classify('pull_request', withAction('opened', { draft: true }), github).kind).toBe('ignore');
    expect(classify('pull_request', withAction('reopened', { state: 'closed' }), github).kind).toBe('ignore');
  });

  test('synchronize only triggers with onPush', () => {
    expect(classify('pull_request', withAction('synchronize'), github).kind).toBe('ignore');
    expect(classify('pull_request', withAction('synchronize'), { ...github, onPush: true }).kind).toBe('prEvent');
  });

  test('edited and other actions are ignored', () => {
    expect(classify('pull_request', withAction('edited'), github).kind).toBe('ignore');
    expect(classify('pull_request', withAction('labeled'), github).kind).toBe('ignore');
  });
});

describe('issue_comment mention', () => {
  const comment = (body: string, association = 'OWNER', type = 'User') => {
    const c = clone(issueComment);
    c.comment.body = body;
    c.comment.author_association = association;
    c.comment.user.type = type;
    return c;
  };

  test('owner mention on a PR requests a review without a SHA', () => {
    const result = classify('issue_comment', comment('please @Review-Relay take a look'), github);
    expect(result).toEqual({
      kind: 'mention',
      // Any word after the mention is passed on; routing decides whether it names a route.
      job: {
        repo: 'Tyru5/Agendex',
        pr: 223,
        source: 'mention',
        reason: '@review-relay from Tyru5',
        route: 'take',
        requestedBy: 'Tyru5',
      },
    });
  });

  test('the word right after the mention may name a route', () => {
    const route = (body: string, mention = '@review-relay') => {
      const result = classify('issue_comment', comment(body), { ...github, mention });
      return result.kind === 'mention' ? result.job.route : 'ignored';
    };
    expect(route('@review-relay Risky')).toBe('risky');
    expect(route('looks done.\n\n@review-relay  deep-dive please')).toBe('deep-dive');
    expect(route('@review-relay')).toBeUndefined();
    expect(route('@review-relay, thanks')).toBeUndefined();
    // The mention text is matched literally, even with characters that mean something in a regex.
    expect(route('(relay) deep', '(relay)')).toBe('deep');
    expect(route('@relay+ deep', '@relay+')).toBe('deep');
    expect(route('@relayyy deep', '@relay+')).toBe('ignored');
  });

  test('the recorded @greptileai comment is not a relay mention', () => {
    expect(classify('issue_comment', issueComment, github).kind).toBe('ignore');
  });

  test('untrusted users, bots and plain issues are ignored', () => {
    expect(classify('issue_comment', comment('@review-relay', 'NONE'), github).kind).toBe('ignore');
    expect(classify('issue_comment', comment('@review-relay', 'OWNER', 'Bot'), github).kind).toBe('ignore');
    const onIssue = comment('@review-relay');
    delete (onIssue.issue as { pull_request?: unknown }).pull_request;
    expect(classify('issue_comment', onIssue, github).kind).toBe('ignore');
  });
});

test('unrelated events are ignored', () => {
  expect(
    classify('deployment_status', { repository: { full_name: 'Tyru5/Agendex' }, state: 'pending' }, github).kind,
  ).toBe('ignore');
  expect(classify('ping', {}, github).kind).toBe('ignore');
});
