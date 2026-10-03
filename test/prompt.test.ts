import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNumstat, promptDiff } from '../src/diffstats.ts';
import { execOrThrow } from '../src/exec.ts';
import { reviewPrompt } from '../src/prompt.ts';
import type { ResolvedJob } from '../src/types.ts';

const job: ResolvedJob = {
  repo: 'o/r',
  pr: 7,
  source: 'manual',
  reason: 'manual run',
  headSha: 'abc123',
  baseRef: 'main',
};
const stats = parseNumstat('2\t0\tsrc/a.ts');

test('by default the agent runs git itself and the CLI enforces the schema', () => {
  const prompt = reviewPrompt(job, stats);
  expect(prompt).toContain('1. Read the change: `git diff origin/main...HEAD` and `git log origin/main..HEAD`.');
  expect(prompt.endsWith('Do not modify any files. Respond only with JSON matching the provided schema.')).toBe(true);
});

test('shell-less harnesses get the diff inline, and schema-less ones get the schema after it', () => {
  const prompt = reviewPrompt(job, stats, { schema: true, diff: 'Diff (git diff origin/main...HEAD):\n+added line' });
  expect(prompt).toContain('are below. You have no shell');
  expect(prompt).toContain('"required":["summary","score","scoreRationale","dimensions","findings"]');
  expect(prompt.indexOf('+added line')).toBeLessThan(prompt.indexOf('Reply with only a JSON object'));
});

test('promptDiff lists commits and cuts long diffs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-diff-'));
  const git = (...args: string[]) => execOrThrow(['git', '-C', dir, ...args]);
  await git('init', '--quiet');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'base');
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(500));
  await git('add', 'a.txt');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'add a');

  const text = await promptDiff(dir, 'HEAD~1', 200);
  expect(text).toMatch(
    /^Commits \(git log HEAD~1\.\.HEAD\):\n[0-9a-f]+ add a\n\nDiff \(git diff HEAD~1\.\.\.HEAD\):\ndiff --git/,
  );
  expect(text).toMatch(/\[diff cut at 200 of \d+ characters; read the changed files for the rest\]$/);
});
