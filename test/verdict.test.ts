import { describe, expect, test } from 'bun:test';
import { parseNumstat } from '../src/diffstats.ts';
import { combinedScore, commentBody } from '../src/report.ts';
import type { ResolvedJob, ReviewerResult } from '../src/types.ts';
import { DIMENSIONS, finalScore, mergeFindings, parseVerdict, type Finding, type Verdict } from '../src/verdict.ts';

const verdict = (score: number, findings: Finding[] = [], dim = 5): Verdict => ({
  summary: 'Adds a thing.',
  score,
  scoreRationale: 'Because.',
  dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: dim, note: `${d} note` }])) as Verdict['dimensions'],
  findings,
});

const finding = (severity: Finding['severity'], file = 'src/a.ts', line: number | null = 10): Finding => ({
  severity, file, line, title: `${severity} issue`, detail: 'It breaks.', suggestion: 'Fix it.',
});

describe('parseVerdict', () => {
  test('accepts schema output and clamps out-of-range numbers', () => {
    const raw = { ...verdict(9), dimensions: { ...verdict(5).dimensions, security: { score: 0, note: 'x' } } };
    const v = parseVerdict(JSON.stringify(raw));
    expect(v.score).toBe(5);
    expect(v.dimensions.security.score).toBe(1);
  });

  test('rejects output missing dimensions', () => {
    expect(() => parseVerdict({ summary: 's', score: 4, findings: [] })).toThrow('dimensions');
  });
});

describe('finalScore caps', () => {
  test('clean verdict keeps its score', () => expect(finalScore(verdict(5))).toBe(5));
  test('a critical finding caps at 2', () => expect(finalScore(verdict(5, [finding('critical')]))).toBe(2));
  test('a major finding caps at 3', () => expect(finalScore(verdict(5, [finding('major'), finding('minor')]))).toBe(3));
  test('minor findings do not cap', () => expect(finalScore(verdict(4, [finding('minor')]))).toBe(4));
  test('overall is at most one above the weakest dimension', () => {
    const v = verdict(5);
    v.dimensions.blastRadius.score = 2;
    expect(finalScore(v)).toBe(3);
  });
});

test('mergeFindings combines nearby findings across reviewers and keeps the worse severity', () => {
  const merged = mergeFindings([
    { reviewer: 'Codex', findings: [finding('minor', 'src/a.ts', 10), finding('major', 'src/b.ts', 5)] },
    { reviewer: 'Claude', findings: [finding('major', 'src/a.ts', 12), finding('minor', 'src/c.ts', null)] },
  ]);
  expect(merged.map((f) => [f.severity, f.file, f.reviewers])).toEqual([
    ['major', 'src/a.ts', ['Codex', 'Claude']],
    ['major', 'src/b.ts', ['Codex']],
    ['minor', 'src/c.ts', ['Claude']],
  ]);
});

test('parseNumstat counts tests and wide-impact files', () => {
  const stats = parseNumstat(
    ['10\t2\tsrc/a.ts', '5\t0\tsrc/a.test.ts', '1\t1\tpackage.json', '-\t-\tlogo.png', '3\t0\t.github/workflows/ci.yml', '7\t0\tdb/migrations/001.sql'].join('\n'),
  );
  expect(stats).toEqual({
    files: 6,
    additions: 26,
    deletions: 3,
    testFiles: 1,
    sensitiveFiles: ['package.json', '.github/workflows/ci.yml', 'db/migrations/001.sql'],
  });
});

describe('commentBody', () => {
  const job: ResolvedJob = {
    repo: 'Tyru5/Agendex', pr: 223, source: 'greptile', reason: 'Greptile started', headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0', baseRef: 'main',
  };
  const stats = parseNumstat('10\t2\tsrc/a.ts');
  const result = (name: 'codex' | 'claude', v: Verdict): ReviewerResult => ({ name, ok: true, output: '', verdict: v, score: finalScore(v), durationMs: 1000 });

  test('headline uses the lowest reviewer score and links findings to the head commit', () => {
    const results = [result('codex', verdict(5)), result('claude', verdict(5, [finding('major')]))];
    expect(combinedScore(results)).toBe(3);
    const body = commentBody(job, results, stats);
    expect(body).toStartWith('<!-- review-relay -->\n## review-relay: Confidence 3/5');
    expect(body).toContain('Codex 5/5, Claude 3/5');
    expect(body).toContain('| Blast radius | 5 | 5 |');
    expect(body).toContain(`[\`src/a.ts:10\`](https://github.com/Tyru5/Agendex/blob/${job.headSha}/src/a.ts#L10)`);
    expect(body).toContain('**Major**');
  });

  test('a failed reviewer is shown and excluded from the score', () => {
    const failed: ReviewerResult = { name: 'codex', ok: false, output: '', error: 'timed out after 1800s', durationMs: 1 };
    const results = [failed, result('claude', verdict(4))];
    expect(combinedScore(results)).toBe(4);
    const body = commentBody(job, results, stats);
    expect(body).toContain('Confidence 4/5');
    expect(body).toContain('> Codex review failed: timed out after 1800s');
    expect(body).toContain('No issues found.');
  });
});
