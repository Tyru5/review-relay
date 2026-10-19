import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priorReview, readFindings, trackFindings } from '../src/lifecycle.ts';
import { reportDirFor } from '../src/report.ts';
import type { Finding } from '../src/verdict.ts';

const finding = (title: string, file = 'src/a.ts', line: number | null = 1): Finding => ({
  severity: 'minor',
  file,
  line,
  title,
  detail: 'd',
  suggestion: 's',
});

/** Writes a report folder as a review does, with or without findings.json. */
function report(
  dataDir: string,
  job: { repo: string; pr: number; headSha: string; source?: 'local'; headRef?: string },
  finishedAt: string,
  byReviewer: Record<string, Finding[] | null>,
  tracked?: boolean,
) {
  const dir = reportDirFor(dataDir, job);
  mkdirSync(dir, { recursive: true });
  // A null entry is a reviewer that failed.
  const reviewers = Object.entries(byReviewer).map(([name, findings]) =>
    findings ? { name, ok: true, score: 4, durationMs: 1 } : { name, ok: false, error: 'timed out', durationMs: 1 },
  );
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...job, finishedAt, reviewers }));
  for (const [name, findings] of Object.entries(byReviewer)) {
    if (findings) writeFileSync(join(dir, `${name}.json`), JSON.stringify({ score: 4, verdict: { findings } }));
  }
  if (tracked) {
    const findings = Object.entries(byReviewer).flatMap(([name, fs]) =>
      (fs ?? []).map((f) => ({ ...f, reviewers: [name], status: 'open', since: 'first000' })),
    );
    writeFileSync(
      join(dir, 'findings.json'),
      JSON.stringify({ headSha: job.headSha, prior: 'x', findings, fixed: [] }),
    );
  }
  return dir;
}

describe('priorReview', () => {
  const pr = (headSha: string) => ({ repo: 'o/r', pr: 7, headSha });

  test('picks the latest earlier review of the PR, never the same commit, and merges old reports without findings.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-lifecycle-'));
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { codex: [finding('Old')] });
    report(dataDir, pr('bbbbbbbb2'), '2026-10-03T00:00:00Z', {
      codex: [finding('Mid')],
      claude: [finding('Mid', 'src/a.ts', 2)],
    });
    // Finished later but it is the commit being reviewed again: a re-review replaces it, so it is no prior.
    report(dataDir, pr('cccccccc3'), '2026-10-05T00:00:00Z', { codex: [finding('Self')] });
    const prior = priorReview(dataDir, pr('cccccccc3'));
    expect(prior?.headSha).toBe('bbbbbbbb2');
    expect(prior?.findings.map((f) => [f.title, f.reviewers, f.agreement])).toEqual([
      ['Mid', ['codex', 'claude'], 'consensus'],
    ]);
    expect(priorReview(dataDir, pr('aaaaaaaa1'))).toEqual({
      headSha: 'cccccccc3',
      findings: [{ ...finding('Self'), reviewers: ['codex'] }],
    });
  });

  test('prefers findings.json, so an open finding keeps the commit it has been open since', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-lifecycle-'));
    const dir = report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { codex: [finding('Old')] }, true);
    expect(readFindings(dir)).toEqual([{ ...finding('Old'), reviewers: ['codex'], status: 'open', since: 'first000' }]);
    expect(priorReview(dataDir, pr('bbbbbbbb2'))?.findings[0]).toMatchObject({ since: 'first000' });
  });

  test('passes over a review where every reviewer failed, even one that wrote findings.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-lifecycle-'));
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { codex: [finding('Old')] });
    const failed = report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', { codex: null, claude: null }, true);
    expect(readFindings(failed)).toBeNull();
    expect(priorReview(dataDir, pr('cccccccc3'))?.headSha).toBe('aaaaaaaa1');
    // One reviewer succeeding is enough, and only its findings count.
    report(dataDir, pr('dddddddd4'), '2026-10-03T00:00:00Z', { codex: null, claude: [finding('Live')] });
    expect(priorReview(dataDir, pr('cccccccc3'))).toEqual({
      headSha: 'dddddddd4',
      findings: [{ ...finding('Live'), reviewers: ['claude'] }],
    });
  });

  test('a finding carried through a review where its reviewer failed keeps its history for the next one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-lifecycle-'));
    const x = finding('Race in cache', 'src/c.ts', 9);
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { codex: [x] });
    // Codex fails on the second commit; Claude runs and reports nothing.
    const second = trackFindings('bbbbbbbb2', [], priorReview(dataDir, pr('bbbbbbbb2')), ['claude']);
    expect(second).toMatchObject({
      fixed: [],
      carried: [{ title: 'Race in cache', since: 'aaaaaaaa1', lastSeen: 'aaaaaaaa1' }],
    });
    const dir = report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', { codex: null, claude: [] });
    writeFileSync(join(dir, 'findings.json'), JSON.stringify(second));
    // The scorecard reads only what the review itself found; the next review also sees what it carried.
    expect(readFindings(dir)).toEqual([]);
    const third = trackFindings('cccccccc3', [{ ...x, reviewers: ['codex'] }], priorReview(dataDir, pr('cccccccc3')), [
      'codex',
    ]);
    expect(third.findings[0]).toMatchObject({ status: 'open', since: 'aaaaaaaa1' });
    expect(third.carried).toBeUndefined();
  });

  test('a local review only looks back at the same branch, and a PR with no history has no prior', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-lifecycle-'));
    const local = (headSha: string, headRef: string) => ({
      repo: 'o/r',
      pr: 0,
      source: 'local' as const,
      headSha,
      headRef,
    });
    report(dataDir, local('aaaaaaaa1', 'feature'), '2026-10-01T00:00:00Z', { codex: [finding('Feature')] });
    report(dataDir, local('bbbbbbbb2', 'other'), '2026-10-02T00:00:00Z', { codex: [finding('Other')] });
    expect(priorReview(dataDir, local('cccccccc3', 'feature'))?.findings[0]?.title).toBe('Feature');
    expect(priorReview(dataDir, local('cccccccc3', 'new-branch'))).toBeNull();
    expect(priorReview(dataDir, pr('dddddddd4'))).toBeNull();
    expect(priorReview(join(dataDir, 'nowhere'), pr('dddddddd4'))).toBeNull();
  });
});
