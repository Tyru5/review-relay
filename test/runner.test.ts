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
  source: 'manual',
  reason: 'manual run',
  headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
  baseRef: 'main',
};

/**
 * A review with every outside step faked: harnesses record their input and answer `verdict` (or fail when listed in
 * `failing`), the checkout is a temp dir holding a `.claude/` that the claude harness lists as a project file, and
 * posts are recorded.
 */
function setup(fields: Record<string, unknown>, opts: { failing?: HarnessName[]; postToPr?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-runner-'));
  const config = parseConfig({ repos: [{ fullName: job.repo, localPath: '/tmp/x' }], dataDir, ...fields });
  const repo: RepoConfig = { ...config.repos[0]!, postToPr: opts.postToPr ?? true };
  const calls: (ReviewerInput & { harness: HarnessName })[] = [];
  const posts: string[] = [];
  const checkouts: string[] = [];
  const fake = (name: HarnessName): Harness => ({
    ...HARNESSES[name],
    projectFiles: name === 'claude' ? ['.claude'] : [],
    run: async (input) => {
      calls.push({ ...input, harness: name });
      const failed = opts.failing?.includes(name);
      return failed
        ? { code: 1, stdout: '', stderr: 'boom', timedOut: false, raw: 'boom' }
        : { code: 0, stdout: '', stderr: '', timedOut: false, raw: JSON.stringify(verdict), verdict };
    },
  });
  const deps: RunnerDeps = {
    harnesses: Object.fromEntries(
      Object.keys(HARNESSES).map((name) => [name, fake(name as HarnessName)]),
    ) as RunnerDeps['harnesses'],
    findBin: (harness) => `/usr/local/bin/${harness}`,
    checkout: async (_repo, _job, _dataDir, fn) => {
      const dir = mkdtempSync(join(tmpdir(), 'relay-checkout-'));
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
      checkouts.push(dir);
      return fn(dir);
    },
    diffStats: async () => parseNumstat('10\t2\tsrc/a.ts'),
    promptDiff: async () => 'Diff (git diff origin/main...HEAD):\n+x',
    post: async (_repo, _pr, body) => {
      posts.push(body);
    },
  };
  return { config, repo, deps, calls, posts, checkouts, dataDir };
}

describe('runReview', () => {
  test('runs one CLI twice under two ids, each with its own settings and scratch directory', async () => {
    const t = setup({
      reviewers: ['claude', 'haiku'],
      models: { haiku: { harness: 'claude', model: 'claude-haiku-4-5', effort: 'low', label: 'Haiku' } },
    });
    const { reportDir } = await runReview(job, t.repo, t.config, t.deps);

    const byScratch = Object.fromEntries(t.calls.map((call) => [call.scratchDir.split('/').at(-1), call]));
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
    expect(existsSync(join(reportDir, 'claude.json'))).toBe(true);
    expect(existsSync(join(reportDir, 'haiku.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(reportDir, 'meta.json'), 'utf8'));
    expect(meta.reviewers).toEqual([
      expect.objectContaining({ name: 'claude', harness: 'claude', model: 'claude-opus-5-5', effort: 'max' }),
      expect.objectContaining({ name: 'haiku', harness: 'claude', model: 'claude-haiku-4-5', timeoutMs: 1_800_000 }),
    ]);

    // Both count as reviewers in the comment: two columns, and their matching findings merge under both labels.
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toContain('lowest of: Claude 5/5, Haiku 5/5');
    expect(t.posts[0]).toContain('| | Claude | Haiku |');
    expect(t.posts[0]).toContain('Off by one _(Claude, Haiku)_');
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
