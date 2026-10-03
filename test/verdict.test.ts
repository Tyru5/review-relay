import { describe, expect, test } from 'bun:test';
import { parseNumstat } from '../src/diffstats.ts';
import { combinedScore, commentBody } from '../src/report.ts';
import { HARNESSES } from '../src/reviewers/index.ts';
import type { ResolvedJob, ReviewerResult } from '../src/types.ts';
import {
  DIMENSIONS,
  finalScore,
  findVerdictJson,
  mergeFindings,
  parseVerdict,
  type Finding,
  type Verdict,
} from '../src/verdict.ts';

const verdict = (score: number, findings: Finding[] = [], dim = 5): Verdict => ({
  summary: 'Adds a thing.',
  score,
  scoreRationale: 'Because.',
  dimensions: Object.fromEntries(
    DIMENSIONS.map((d) => [d, { score: dim, note: `${d} note` }]),
  ) as Verdict['dimensions'],
  findings,
});

const finding = (severity: Finding['severity'], file = 'src/a.ts', line: number | null = 10): Finding => ({
  severity,
  file,
  line,
  title: `${severity} issue`,
  detail: 'It breaks.',
  suggestion: 'Fix it.',
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

describe('findVerdictJson', () => {
  test('takes the last verdict out of prose, a draft, and a code fence', () => {
    const final = verdict(4);
    const text = `Draft: ${JSON.stringify(verdict(2))}\n\nFinal:\n\`\`\`json\n${JSON.stringify(final, null, 2)}\n\`\`\`\nDone {ok}.`;
    expect(findVerdictJson(text)).toEqual(final);
  });

  test('ignores braces inside strings', () => {
    const tricky = { ...verdict(3), summary: 'Escapes "}" and a stray { in text' };
    expect(findVerdictJson(`Here: ${JSON.stringify(tricky)}`)).toEqual(tricky);
  });

  test('falls back to the last object that parses, so parseVerdict can name the gap', () => {
    expect(findVerdictJson('{"a": 1} then {"summary": "s", "nested": {"b": 2}}')).toEqual({
      summary: 's',
      nested: { b: 2 },
    });
    expect(() => findVerdictJson('no json { here')).toThrow('no JSON object');
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
    [
      '10\t2\tsrc/a.ts',
      '5\t0\tsrc/a.test.ts',
      '1\t1\tpackage.json',
      '-\t-\tlogo.png',
      '3\t0\t.github/workflows/ci.yml',
      '7\t0\tdb/migrations/001.sql',
      '',
    ].join('\0'),
  );
  expect(stats).toMatchObject({
    files: 6,
    additions: 26,
    deletions: 3,
    testFiles: 1,
    sensitiveFiles: ['package.json', '.github/workflows/ci.yml', 'db/migrations/001.sql'],
    counted: { files: 6, additions: 26, deletions: 3 },
  });
  expect(stats.changed[3]).toEqual({ path: 'logo.png', additions: 0, deletions: 0 });
});

test('parseNumstat reads both paths of a renamed file, which plain numstat folds into one', () => {
  // Plain numstat prints `src/{a.test.ts => b.test.ts}`, which matched neither detector.
  const stats = parseNumstat(
    ['0\t0\t', 'src/a.test.ts', 'src/b.test.ts', '2\t0\t', 'sql/001.sql', 'sql/002.sql', '1\t0\tdocs/a b.md', ''].join(
      '\0',
    ),
  );
  expect(stats.changed).toEqual([
    { path: 'src/b.test.ts', oldPath: 'src/a.test.ts', additions: 0, deletions: 0 },
    { path: 'sql/002.sql', oldPath: 'sql/001.sql', additions: 2, deletions: 0 },
    { path: 'docs/a b.md', additions: 1, deletions: 0 },
  ]);
  expect(stats.testFiles).toBe(1);
  expect(stats.sensitiveFiles).toEqual(['sql/002.sql']);
});

test('parseNumstat leaves lockfiles out of the counted totals', () => {
  const stats = parseNumstat(
    ['5000\t20\tbun.lock', '12\t3\tpackages/web/pnpm-lock.yaml', '20\t0\tsrc/a.ts', '1\t1\tpackage.json', ''].join(
      '\0',
    ),
  );
  expect(stats).toMatchObject({ files: 4, additions: 5033, deletions: 24 });
  expect(stats.counted).toEqual({ files: 2, additions: 21, deletions: 1 });
  // Lockfiles still count as wide-impact: a dependency change is a supply-chain risk.
  expect(stats.sensitiveFiles).toEqual(['bun.lock', 'packages/web/pnpm-lock.yaml', 'package.json']);
});

describe('commentBody', () => {
  const job: ResolvedJob = {
    repo: 'Tyru5/Agendex',
    pr: 223,
    source: 'greptile',
    reason: 'Greptile started',
    headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
    baseRef: 'main',
  };
  const stats = parseNumstat('10\t2\tsrc/a.ts\0');
  const ran = (name: 'codex' | 'claude') => ({
    name,
    harness: name,
    label: HARNESSES[name].label,
    timeoutMs: 1_800_000,
  });
  const result = (name: 'codex' | 'claude', v: Verdict): ReviewerResult => ({
    ...ran(name),
    ok: true,
    output: '',
    verdict: v,
    score: finalScore(v),
    durationMs: 1000,
  });

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
    const failed: ReviewerResult = {
      ...ran('codex'),
      ok: false,
      output: '',
      error: 'timed out after 1800s',
      durationMs: 1,
    };
    const results = [failed, result('claude', verdict(4))];
    expect(combinedScore(results)).toBe(4);
    const body = commentBody(job, results, stats);
    expect(body).toContain('Confidence 4/5');
    expect(body).toContain('> Codex review failed: timed out after 1800s');
    expect(body).toContain('No issues found.');
  });
});
