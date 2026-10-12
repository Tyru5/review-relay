import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('info resolves custom reviewer executables and JSON commands keep warnings on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        port: 1,
        dataDir: dir,
        repos: [{ fullName: 'o/r', localPath: dir }],
        reviewers: ['haiku'],
        models: { haiku: { harness: 'claude' }, codex: { unknown: 'ignored' } },
      }),
    );
    for (const args of [['info'], ['info', '--json'], ['config']]) {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args, '--config', config],
        {
          env: { ...process.env, PATH: dir, NO_COLOR: '1' },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toContain('warning:');
      const output = result.stdout.toString();
      if (args.length === 1 && args[0] === 'info') {
        expect(output).toContain('haiku');
        expect(output).toContain('on claude');
        expect(output).toContain('claude not on PATH');
      } else {
        expect(JSON.parse(output).models.haiku.harness).toBe('claude');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cost lists each review’s cost per reviewer, filters by repo and PR, and prints JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-cost-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ dataDir: dir, repos: [{ fullName: 'o/r', localPath: dir }] }));
    const record = (repo: string, pr: number, sha: string) => ({
      key: `${repo}@${sha}`,
      repo,
      pr,
      headSha: sha,
      source: 'github',
      status: 'done',
      startedAt: `2026-10-0${pr}T10:00:00.000Z`,
      finishedAt: `2026-10-0${pr}T10:05:00.000Z`,
    });
    const jobs = [record('o/r', 2, 'aaaaaaaa11'), record('o/other', 1, 'bbbbbbbb22')];
    writeFileSync(join(dir, 'state.json'), JSON.stringify(jobs));
    const usage = (costUsd: number, costSource: string) => ({
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2_000,
      costUsd,
      costSource,
    });
    for (const job of jobs) {
      const report = join(dir, 'reports', job.repo.replace('/', '__'), `pr-${job.pr}`, job.headSha.slice(0, 8));
      mkdirSync(report, { recursive: true });
      writeFileSync(
        join(report, 'meta.json'),
        JSON.stringify({
          reviewers: [
            { name: 'codex', model: 'gpt-6-astra', ok: true, durationMs: 1, usage: usage(0.5, 'estimated') },
            { name: 'claude', ok: true, durationMs: 1, usage: usage(1.25, 'reported') },
          ],
        }),
      );
    }
    const cost = (...args: string[]) => {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, '../src/cli.ts'), 'cost', ...args, '--config', config],
        { env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };

    const all = cost();
    expect(all).toMatch(/CODEX\s+CLAUDE\s+TOTAL/);
    expect(all).toContain('~$0.50 · 100k in/2k out  $1.25 · 100k in/2k out  ~$1.75');
    expect(all).toMatch(/total\s+~\$3\.50\s+2 reviews · ~\$1\.75 per review/);
    expect(all).toMatch(/claude\s+\$2\.50\s+2 reviews/);

    const one = cost('--repo', 'O/R', '--pr', '2');
    expect(one).toContain('Review costs  O/R #2');
    expect(one).not.toContain('o/other');
    expect(one).toMatch(/total\s+~\$1\.75\s+1 review /);

    const json = JSON.parse(cost('--json'));
    expect(json).toMatchObject({
      reviews: 2,
      costUsd: 3.5,
      estimated: true,
      partial: false,
      costedReviews: 2,
      averageUsd: 1.75,
      unpriced: [],
    });
    expect(json.reviewers.map((r: { name: string; costUsd: number }) => [r.name, r.costUsd])).toEqual([
      ['codex', 1],
      ['claude', 2.5],
    ]);
    expect(json.jobs[0]).toMatchObject({ repo: 'o/r', pr: 2, costUsd: 1.75 });
    expect(json.jobs[0].reviewers[0]).toMatchObject({ name: 'codex', model: 'gpt-6-astra', usage: { costUsd: 0.5 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('review', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-review-cli-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(import.meta.dir, '../src/cli.ts');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const config = join(root, 'config.json');
  const sh = (cmd: string[], cwd = root) => {
    const r = Bun.spawnSync(cmd, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr}`);
  };
  const verdict = {
    // An OSC 52 clipboard write a prompt-injected reviewer might try to send to the terminal.
    summary: 'Adds b.\u001b]52;c;cHduZWQ=\u0007',
    score: 4,
    scoreRationale: 'Fine.',
    dimensions: Object.fromEntries(
      ['correctness', 'security', 'codeQuality', 'standards', 'blastRadius', 'testing'].map((d) => [
        d,
        { score: 4, note: 'ok' },
      ]),
    ),
    findings: [],
  };

  beforeAll(() => {
    sh(['git', 'init', '--quiet', '--bare', '--initial-branch=main', join(root, 'origin.git')]);
    sh(['git', 'clone', '--quiet', join(root, 'origin.git'), repo]);
    sh(['git', 'checkout', '--quiet', '-b', 'main'], repo);
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    sh(['git', 'add', '.'], repo);
    sh(['git', 'commit', '--quiet', '-m', 'base'], repo);
    sh(['git', 'push', '--quiet', 'origin', 'main'], repo);
    sh(['git', 'checkout', '--quiet', '-b', 'feat'], repo);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    sh(['git', 'add', '.'], repo);
    sh(['git', 'commit', '--quiet', '-m', 'add b'], repo);
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ type: 'result', structured_output: verdict })}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      config,
      JSON.stringify({
        dataDir: join(root, 'data'),
        repos: [{ fullName: 'o/r', localPath: repo }],
        reviewers: ['claude'],
      }),
    );
  });

  const review = (args: string[], cwd = repo) => {
    const r = Bun.spawnSync([process.execPath, cli, 'review', '--config', config, ...args], {
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test('prints the review with escapes stripped, and --min-score sets the exit code', () => {
    const below = review(['--min-score', '5']);
    expect(below.code).toBe(1);
    expect(below.out).toContain('review-relay: Confidence 4/5');
    expect(below.out).not.toContain('\u001b');
    expect(below.err).toContain('confidence 4/5 is under --min-score 5');
    expect(review(['--min-score', '4']).code).toBe(0);
  });

  test('--json prints the score, the base by name and SHA, each reviewer, and the findings', () => {
    const { code, out } = review(['--json']);
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(Object.keys(json)).toEqual([
      'repo',
      'branch',
      'headSha',
      'base',
      'baseSha',
      'commits',
      'score',
      'route',
      'reportDir',
      'reviewers',
      'findings',
    ]);
    expect(json).toMatchObject({ repo: 'o/r', branch: 'feat', base: 'origin/main', commits: 1, score: 4 });
    expect(json.reviewers[0]).toMatchObject({ name: 'claude', ok: true, score: 4 });
    expect(json.reviewers[0].output).toBeUndefined();
  });

  test('refuses flags that conflict', () => {
    expect(review(['-d', '--json']).err).toContain('--json and --min-score report in the foreground');
    expect(review(['--route', 'x', '--reviewers', 'claude']).err).toContain('pass --route or --reviewers, not both');
    expect(review(['--min-score', '9']).err).toContain('--min-score takes 1 to 5');
    expect(review(['--reviewers', 'nope']).err).toContain('no reviewer named nope');
  });

  test('-d from a subfolder with a relative --config reviews in the background and records the job', async () => {
    const r = Bun.spawnSync([process.execPath, cli, 'review', '-d', '--config', '../../config.json'], {
      cwd: join(repo, 'src'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain('reviewing in the background');
    const state = join(root, 'data', 'state.json');
    let job: { status: string; branch: string; base: string } | undefined;
    for (let i = 0; i < 100 && job?.status !== 'done'; i++) {
      await Bun.sleep(100);
      try {
        job = JSON.parse(readFileSync(state, 'utf8')).find((j: { key: string }) => j.key.endsWith(':local'));
      } catch {
        // Not written yet.
      }
    }
    expect(job).toMatchObject({ status: 'done', branch: 'feat', base: 'origin/main' });
  });
});
