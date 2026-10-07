import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type RepoConfig } from '../src/config.ts';
import { parseNumstat } from '../src/diffstats.ts';
import { reportDirFor } from '../src/report.ts';
import { HARNESSES } from '../src/reviewers/index.ts';
import type { Harness, ReviewerInput } from '../src/reviewers/types.ts';
import { runReview, type RunnerDeps } from '../src/runner.ts';
import type { HarnessName, ResolvedJob } from '../src/types.ts';
import { DIMENSIONS, type Verdict } from '../src/verdict.ts';

const verdict: Verdict = {
  summary: 'Adds median().',
  score: 5,
  scoreRationale: 'Small and tested.',
  dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 5, note: 'ok' }])) as Verdict['dimensions'],
  findings: [{ severity: 'minor', file: 'src/a.ts', line: 3, title: 'Off by one', detail: 'd', suggestion: 's' }],
};

const job: ResolvedJob = {
  repo: 'Tyru5/Agendex',
  pr: 7,
  source: 'github',
  reason: 'pull_request opened',
  headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
  baseRef: 'main',
};

const HAIKU = { harness: 'claude', model: 'claude-haiku-4-5', label: 'Haiku' };

/**
 * A review with every outside step faked: harnesses record their input and answer `verdict` (or fail when listed in
 * `failing`), the diff is `files` (numstat lines), the checkout is a temp dir holding a `.claude/` that the claude
 * harness lists as a project file, and fetches, checkouts, and posts are recorded.
 */
function setup(
  fields: Record<string, unknown>,
  opts: { failing?: HarnessName[]; postToPr?: boolean; files?: string[] } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-runner-'));
  const config = parseConfig({ repos: [{ fullName: job.repo, localPath: '/tmp/x' }], dataDir, ...fields });
  const repo: RepoConfig = { ...config.repos[0]!, postToPr: opts.postToPr ?? true };
  const calls: (ReviewerInput & { harness: HarnessName })[] = [];
  const posts: string[] = [];
  const fetches: string[] = [];
  const checkouts: string[] = [];
  const fake = (name: HarnessName): Harness => ({
    ...HARNESSES[name],
    projectFiles: name === 'claude' ? ['.claude'] : [],
    run: async (input) => {
      calls.push({ ...input, harness: name });
      return opts.failing?.includes(name)
        ? { code: 1, stdout: '', stderr: 'boom', timedOut: false, raw: 'boom' }
        : { code: 0, stdout: '', stderr: '', timedOut: false, raw: JSON.stringify(verdict), verdict };
    },
  });
  const deps: RunnerDeps = {
    harnesses: Object.fromEntries(
      Object.keys(HARNESSES).map((name) => [name, fake(name as HarnessName)]),
    ) as RunnerDeps['harnesses'],
    findBin: (harness) => `/usr/local/bin/${harness}`,
    fetch: async (_repo, j) => {
      fetches.push(j.headSha);
    },
    diffStats: async () => parseNumstat([...(opts.files ?? ['10\t2\tsrc/a.ts']), ''].join('\0')),
    checkout: async (_repo, _job, _dataDir, fn) => {
      const dir = mkdtempSync(join(tmpdir(), 'relay-checkout-'));
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
      checkouts.push(dir);
      return fn(dir);
    },
    promptDiff: async () => 'Diff (git diff origin/main...HEAD):\n+x',
    post: async (_repo, _pr, body) => {
      posts.push(body);
    },
    prHead: async () => job.headSha,
  };
  const scratch = (call: ReviewerInput) => call.scratchDir.split('/').at(-1)!;
  return { config, repo, deps, calls, posts, fetches, checkouts, dataDir, scratch };
}

describe('runReview', () => {
  test('a local review writes its report under local/, links nothing, and never posts', async () => {
    const t = setup({ reviewers: ['claude'] }, { postToPr: true });
    const local: ResolvedJob = {
      ...job,
      pr: 0,
      source: 'local',
      reason: 'local review of feature against origin/main',
      headRef: 'feature',
      base: 'origin/main',
    };
    const outcome = await runReview(local, t.repo, t.config, t.deps);
    expect(t.posts).toEqual([]);
    expect(outcome.reportDir).toBe(join(t.dataDir, 'reports', 'Tyru5__Agendex', 'local', '1e210c5c'));
    expect(outcome.results?.map((r) => r.score)).toEqual([5]);
    expect(outcome.comment).toContain('`src/a.ts:3`: Off by one');
    expect(outcome.comment).not.toContain('https://github.com');
    expect(t.calls[0]!.prompt).toContain('scoring the branch feature in Tyru5/Agendex, before it is opened');
    expect(t.calls[0]!.scratchDir).toContain(`-local${process.pid}-1e210c5c`);
  });

  test('runs one CLI twice under two ids, each with its own settings and scratch directory', async () => {
    const t = setup({
      reviewers: ['claude', 'haiku'],
      models: { haiku: { ...HAIKU, effort: 'low' } },
    });
    const { reportDir, route } = await runReview(job, t.repo, t.config, t.deps);
    expect(route).toBeUndefined();

    const byScratch = Object.fromEntries(t.calls.map((call) => [t.scratch(call), call]));
    expect(Object.keys(byScratch).toSorted()).toEqual(['claude', 'haiku']);
    expect(byScratch.claude).toMatchObject({
      harness: 'claude',
      bin: '/usr/local/bin/claude',
      model: 'claude-opus-5-5',
      effort: 'max',
      timeoutMs: 1_800_000,
    });
    expect(byScratch.haiku).toMatchObject({
      harness: 'claude',
      bin: '/usr/local/bin/claude',
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
    // Shell-less harnesses get the diff in the prompt.
    expect(byScratch.haiku!.prompt).toContain('Diff (git diff origin/main...HEAD)');

    expect(reportDir).toBe(reportDirFor(t.dataDir, job));
    expect(existsSync(join(reportDir!, 'claude.json'))).toBe(true);
    expect(existsSync(join(reportDir!, 'haiku.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(reportDir!, 'meta.json'), 'utf8'));
    expect(meta.route).toBeNull();
    expect(meta.reviewers).toEqual([
      expect.objectContaining({ name: 'claude', harness: 'claude', model: 'claude-opus-5-5', effort: 'max' }),
      expect.objectContaining({ name: 'haiku', harness: 'claude', model: 'claude-haiku-4-5', timeoutMs: 1_800_000 }),
    ]);

    // Both count as reviewers in the comment: two columns, and their matching findings merge under both labels.
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toContain('lowest of: Claude 5/5, Haiku 5/5</sub>\n\n');
    expect(t.posts[0]).toContain('| | Claude | Haiku |');
    expect(t.posts[0]).toContain('Off by one _(Claude, Haiku)_');
    expect(t.posts[0]).not.toContain('Route');
  });

  test('deletes the project files of the CLIs the reviewers run, found by harness', async () => {
    const custom = setup({ reviewers: ['mini'], models: { mini: { harness: 'claude' } } });
    await runReview(job, custom.repo, custom.config, custom.deps);
    expect(existsSync(join(custom.checkouts[0]!, '.claude'))).toBe(false);

    const other = setup({ reviewers: ['codex'] });
    await runReview(job, other.repo, other.config, other.deps);
    expect(existsSync(join(other.checkouts[0]!, '.claude'))).toBe(true);
  });

  test('posts only when the repo asks, and fails when every reviewer fails', async () => {
    const quiet = setup({ reviewers: ['codex'] }, { postToPr: false });
    await runReview(job, quiet.repo, quiet.config, quiet.deps);
    expect(quiet.posts).toEqual([]);

    const broken = setup(
      { reviewers: ['claude', 'mini'], models: { mini: { harness: 'claude' } } },
      { failing: ['claude'] },
    );
    await expect(runReview(job, broken.repo, broken.config, broken.deps)).rejects.toThrow(
      'all reviewers failed (claude: exit 1: boom; mini: exit 1: boom)',
    );
  });
});

describe('stale commits', () => {
  const NEWER = 'ffffffffffffffffffffffffffffffffffffffff';

  test('posts nothing once the PR has moved past the reviewed commit, but keeps the local report', async () => {
    const t = setup({ reviewers: ['codex'] });
    t.deps.prHead = async () => NEWER;
    const outcome = await runReview(job, t.repo, t.config, t.deps);
    expect(outcome.supersededBy).toBe(NEWER);
    expect(t.posts).toEqual([]);
    expect(existsSync(join(outcome.reportDir!, 'comment.md'))).toBe(true);
  });

  test("a newer commit's review waits for an older one's post, so the PR keeps one comment, the newer", async () => {
    const t = setup({ reviewers: ['codex'] });
    // GitHub as upsertComment sees it: it looks for the comment, then creates or edits it a moment later.
    const comments: string[] = [];
    let head = job.headSha;
    let posting!: () => void;
    const olderPosting = new Promise<void>((resolve) => (posting = resolve));
    t.deps.prHead = async () => head;
    t.deps.post = async (_repo, _pr, body) => {
      const existing = comments.length > 0;
      posting();
      await Bun.sleep(150);
      if (existing) comments[0] = body;
      else comments.push(body);
    };

    const older = runReview(job, t.repo, t.config, t.deps);
    await olderPosting;
    head = NEWER;
    const newer = runReview({ ...job, headSha: NEWER }, t.repo, t.config, t.deps);
    expect((await older).supersededBy).toBeUndefined();
    expect((await newer).supersededBy).toBeUndefined();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`Commit \`${NEWER.slice(0, 8)}\``);
  });

  test('an abort kills the reviewers and ends the review with no report and no post', async () => {
    const t = setup({ reviewers: ['codex'] });
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const signals: (AbortSignal | undefined)[] = [];
    t.deps.harnesses.codex = {
      ...t.deps.harnesses.codex,
      run: async (input) => {
        signals.push(input.signal);
        started();
        await new Promise((resolve) => input.signal!.addEventListener('abort', resolve));
        return { code: 143, stdout: '', stderr: '', timedOut: false, raw: '' };
      },
    };
    const review = runReview(job, t.repo, t.config, t.deps, controller.signal);
    await running;
    controller.abort(NEWER);
    expect(await review).toEqual({ route: undefined, supersededBy: NEWER });
    expect(signals).toEqual([controller.signal]);
    expect(t.posts).toEqual([]);
    expect(existsSync(reportDirFor(t.dataDir, job))).toBe(false);
  });
});

describe('routing', () => {
  const routes = [
    { name: 'docs', when: { onlyPaths: ['docs/**', '**/*.md'] }, skip: true },
    { name: 'risky', when: { wideImpact: true }, reviewers: ['claude', 'codex'], timeoutMs: 3_600_000 },
    { name: 'tiny', when: { maxLines: 30 }, reviewers: ['haiku'] },
  ];
  const fields = { reviewers: ['codex'], models: { haiku: HAIKU }, routes };

  test('the first matching route picks the reviewers and their timeout, and the comment says why', async () => {
    const t = setup(fields, { files: ['1\t1\tpackage.json', '3\t0\tsrc/a.ts'] });
    const outcome = await runReview(job, t.repo, t.config, t.deps);
    expect(outcome.route).toEqual({ name: 'risky', reason: 'wide-impact: package.json', forced: false });
    // Reviewers start in parallel, so their calls can land in either order.
    expect(t.calls.map((call) => [t.scratch(call), call.timeoutMs]).toSorted()).toEqual([
      ['claude', 3_600_000],
      ['codex', 3_600_000],
    ]);
    expect(t.posts[0]).toContain(
      'lowest of: Claude 5/5, Codex 5/5</sub><br>\n<sub>Route `risky` (wide-impact: package.json) · Claude: claude-opus-5-5, max · Codex: gpt-6-astra, high</sub>\n',
    );
    const meta = JSON.parse(readFileSync(join(outcome.reportDir!, 'meta.json'), 'utf8'));
    expect(meta.route).toEqual(outcome.route);
  });

  test('a small change matches the cheap route; no match runs the fallback and lists only the models', async () => {
    const tiny = setup(fields, { files: ['10\t2\tsrc/a.ts'] });
    expect((await runReview(job, tiny.repo, tiny.config, tiny.deps)).route?.name).toBe('tiny');
    expect(tiny.calls.map(tiny.scratch)).toEqual(['haiku']);
    expect(tiny.calls[0]!.timeoutMs).toBe(1_800_000);

    const big = setup(fields, { files: ['300\t2\tsrc/a.ts'] });
    expect((await runReview(job, big.repo, big.config, big.deps)).route).toBeUndefined();
    expect(big.calls.map(big.scratch)).toEqual(['codex']);
    expect(big.posts[0]).toContain('</sub><br>\n<sub>Codex: gpt-6-astra, high</sub>\n');
  });

  test('a skip route stops before any checkout, posts nothing, and never applies to a mention or run', async () => {
    const t = setup(fields, { files: ['3\t1\tdocs/a.md', '1\t0\tREADME.md'] });
    expect(await runReview(job, t.repo, t.config, t.deps)).toEqual({
      route: { name: 'docs', reason: 'onlyPaths: 2 files', forced: false },
      skipped: true,
    });
    expect(t.fetches).toHaveLength(1);
    expect(t.checkouts).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.posts).toEqual([]);

    for (const source of ['mention', 'manual'] as const) {
      const asked = setup(fields, { files: ['3\t1\tdocs/a.md'] });
      const outcome = await runReview({ ...job, source }, asked.repo, asked.config, asked.deps);
      expect(outcome.skipped).toBeUndefined();
      expect(outcome.route?.name).toBe('tiny');
    }
  });

  test('a skip route never skips a PR that changes an agent file', async () => {
    const t = setup(fields, { files: ['3\t1\tdocs/a.md', '1\t0\tAGENTS.md'] });
    const outcome = await runReview(job, t.repo, t.config, t.deps);
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.route?.name).toBe('tiny');
    expect(t.checkouts).toHaveLength(1);
  });

  test('a route the request names runs even when another matches first, but a skip route cannot be named', async () => {
    const t = setup(fields, { files: ['3\t1\tdocs/a.md'] });
    const mention = { ...job, source: 'mention' as const, route: 'risky', requestedBy: 'tyru5' };
    const outcome = await runReview(mention, t.repo, t.config, t.deps);
    expect(outcome.route).toEqual({ name: 'risky', reason: 'requested by @tyru5', forced: true });
    expect(t.posts[0]).toContain('<sub>Route `risky` (requested by @tyru5) · Claude');

    const docs = setup(fields, { files: ['3\t1\tdocs/a.md'] });
    const named = await runReview({ ...job, source: 'mention', route: 'docs' }, docs.repo, docs.config, docs.deps);
    expect(named.skipped).toBeUndefined();
    expect(named.route?.name).toBe('tiny');
  });
});
