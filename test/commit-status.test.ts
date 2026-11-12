import { describe, expect, test } from 'bun:test';
import { commitStatusFor, type JobEvent } from '../src/commit-status.ts';
import type { ResolvedJob, ReviewerResult } from '../src/types.ts';

const job: ResolvedJob = {
  repo: 'acme/widget',
  pr: 42,
  source: 'github',
  reason: 'pull_request opened',
  headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
  baseRef: 'main',
};
const PR = 'https://github.com/acme/widget/pull/42';
const COMMENT = `${PR}#issuecomment-9`;

const reviewer = (label: string, score?: number): ReviewerResult => ({
  name: label.toLowerCase(),
  harness: 'claude',
  label,
  timeoutMs: 1,
  ok: score !== undefined,
  output: '',
  durationMs: 1,
  ...(score !== undefined ? { score } : { error: 'boom' }),
});

const done = (results: ReviewerResult[], commentUrl?: string): JobEvent => ({
  phase: 'finished',
  job,
  status: 'done',
  outcome: { results, ...(commentUrl ? { commentUrl } : {}) },
});

describe('commitStatusFor', () => {
  test('passes at minScore and fails one under, on the lowest successful reviewer', () => {
    // Claude 3 is the combined score; a failed reviewer doesn't count against it.
    const results = [reviewer('Claude', 3), reviewer('Codex', 5), reviewer('Gemini')];
    expect(commitStatusFor(done(results, COMMENT), { minScore: 3 })).toEqual({
      state: 'success',
      description: 'Confidence 3/5 (needs 3) · Claude 3, Codex 5, Gemini failed',
      targetUrl: COMMENT,
    });
    expect(commitStatusFor(done(results), { minScore: 4 })).toMatchObject({
      state: 'failure',
      description: 'Confidence 3/5 (needs 4) · Claude 3, Codex 5, Gemini failed',
      targetUrl: PR,
    });
  });

  test('pending on start; skipped passes; failed and cancelled are errors; superseded is left alone', () => {
    const config = { minScore: 4 };
    expect(commitStatusFor({ phase: 'started', job }, config)).toEqual({
      state: 'pending',
      description: 'Reviewing',
      targetUrl: PR,
    });
    const skipped: JobEvent = {
      phase: 'finished',
      job,
      status: 'skipped',
      outcome: { skipped: true, route: { name: 'docs', reason: 'onlyPaths', forced: false } },
    };
    expect(commitStatusFor(skipped, config)).toMatchObject({ state: 'success', description: 'Skipped by route docs' });
    const failed = commitStatusFor({ phase: 'finished', job, status: 'failed', error: 'x'.repeat(300) }, config);
    expect(failed).toMatchObject({ state: 'error' });
    expect(failed!.description).toBe(`Review failed: ${'x'.repeat(100)}`);
    expect(commitStatusFor({ phase: 'finished', job, status: 'cancelled' }, config)).toMatchObject({
      state: 'error',
      description: 'Review cancelled',
    });
    expect(commitStatusFor({ phase: 'finished', job, status: 'superseded' }, config)).toBeNull();
  });
});
