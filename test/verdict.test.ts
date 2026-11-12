import { describe, expect, test } from 'bun:test';
import { parseNumstat } from '../src/diffstats.ts';
import { combinedScore, commentBody } from '../src/report.ts';
import { HARNESSES } from '../src/reviewers/index.ts';
import type { ResolvedJob, ReviewerResult } from '../src/types.ts';
import { matchFindings, sameFinding, trackFindings } from '../src/lifecycle.ts';
import {
  agreementOf,
  DIMENSIONS,
  finalScore,
  findVerdictJson,
  mergeFindings,
  parseVerdict,
  titleSimilarity,
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

test('mergeFindings merges file-level findings only when their titles are alike', () => {
  const merged = mergeFindings([
    { reviewer: 'a', findings: [{ ...finding('minor', 'src/a.ts', null), title: 'Missing tests for retries' }] },
    {
      reviewer: 'b',
      findings: [
        { ...finding('major', 'src/a.ts', null), title: 'SQL built by string concat' },
        { ...finding('minor', 'src/a.ts', 7), title: 'Tests missing for retries' },
      ],
    },
  ]);
  // The two file-level remarks stay apart; the one at a line merges with the alike file-level title and keeps the line.
  expect(merged.map((f) => [f.title, f.line, f.reviewers])).toEqual([
    ['SQL built by string concat', null, ['b']],
    ['Missing tests for retries', 7, ['a', 'b']],
  ]);
});

test('mergeFindings combines nearby findings across reviewers and keeps the worse severity', () => {
  const merged = mergeFindings([
    { reviewer: 'Codex', findings: [finding('minor', 'src/a.ts', 10), finding('major', 'src/b.ts', 5)] },
    { reviewer: 'Claude', findings: [finding('major', 'src/a.ts', 12), finding('minor', 'src/c.ts', null)] },
  ]);
  expect(merged.map((f) => [f.severity, f.file, f.reviewers, f.agreement])).toEqual([
    ['major', 'src/a.ts', ['Codex', 'Claude'], 'consensus'],
    ['major', 'src/b.ts', ['Codex'], 'single'],
    ['minor', 'src/c.ts', ['Claude'], 'single'],
  ]);
});

test('mergeFindings puts the findings more reviewers agree on first within a severity, and tags the dimension', () => {
  const tagged = { ...finding('major', 'src/b.ts', 5), dimension: 'security' as const };
  const merged = mergeFindings([
    { reviewer: 'a', findings: [finding('major', 'src/a.ts', 1), finding('major', 'src/b.ts', 5)] },
    { reviewer: 'b', findings: [tagged] },
    { reviewer: 'c', findings: [tagged] },
  ]);
  expect(merged.map((f) => [f.file, f.agreement, f.dimension])).toEqual([
    ['src/b.ts', 'consensus', 'security'],
    ['src/a.ts', 'single', undefined],
  ]);
});

test('agreementOf: all is consensus, more than half majority, several minority, one single; one reviewer has none', () => {
  expect(agreementOf(1, 1)).toBeUndefined();
  expect(agreementOf(2, 2)).toBe('consensus');
  expect(agreementOf(2, 3)).toBe('majority');
  expect(agreementOf(1, 2)).toBe('single');
  expect(agreementOf(1, 4)).toBe('single');
  expect(agreementOf(2, 4)).toBe('minority');
  expect(agreementOf(3, 6)).toBe('minority');
});

test('parseVerdict keeps a known dimension and drops an invented one', () => {
  const raw = verdict(4, [
    { ...finding('minor'), dimension: 'security' },
    { ...finding('minor'), dimension: 'vibes' as never },
  ]);
  const [a, b] = parseVerdict(JSON.stringify(raw)).findings;
  expect(a!.dimension).toBe('security');
  expect(b).not.toHaveProperty('dimension');
});

test('parseVerdict keeps a forward range and a replacement only for a finding with a line', () => {
  const raw = verdict(4, [
    { ...finding('minor', 'src/a.ts', 10), endLine: 12, replacement: 'x' },
    // A backwards or one-line range is dropped; an empty replacement deletes lines, so it stays.
    { ...finding('minor', 'src/a.ts', 10), endLine: 9, replacement: '' },
    { ...finding('minor', 'src/a.ts', 10), endLine: 10, replacement: null as never },
    // Without a line there is nothing to replace.
    { ...finding('minor', 'src/a.ts', null), endLine: 4, replacement: 'y' },
  ]);
  const [a, b, c, d] = parseVerdict(JSON.stringify(raw)).findings;
  expect([a!.endLine, a!.replacement]).toEqual([12, 'x']);
  expect([b!.endLine, b!.replacement]).toEqual([undefined, '']);
  expect(c).not.toHaveProperty('endLine');
  expect(c).not.toHaveProperty('replacement');
  expect(d).not.toHaveProperty('endLine');
  expect(d).not.toHaveProperty('replacement');
});

test('mergeFindings keeps the first replacement and takes another only for the same line', () => {
  const at = (line: number, replacement?: string, endLine?: number): Finding => ({
    ...finding('minor', 'src/a.ts', line),
    ...(replacement !== undefined ? { replacement } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  });
  const merge = (...byReviewer: Finding[]) =>
    mergeFindings(byReviewer.map((f, i) => ({ reviewer: `r${i}`, findings: [f] })))[0]!;
  expect(merge(at(10, 'first'), at(10, 'second', 11))).toMatchObject({ replacement: 'first' });
  expect(merge(at(10, 'first'), at(10, 'second', 11)).endLine).toBeUndefined();
  // The first has none; the second names the same line, so its replacement and range come along.
  expect(merge(at(10), at(10, 'second', 11))).toMatchObject({ replacement: 'second', endLine: 11 });
  // A nearby line is the same finding but not the same lines, so its replacement would edit the wrong ones.
  expect(merge(at(10), at(12, 'second'))).not.toHaveProperty('replacement');
});

test('titleSimilarity compares the words of two titles', () => {
  expect(titleSimilarity('Missing null check on user', 'Null check missing for user input')).toBeCloseTo(4 / 6);
  expect(titleSimilarity('Off by one', 'Race in cache eviction')).toBe(0);
  expect(titleSimilarity('', 'x')).toBe(0);
});

describe('trackFindings', () => {
  const merged = (f: Finding, ...reviewers: string[]) => ({ ...f, reviewers });
  const prior = {
    headSha: 'aaaaaaaa1111',
    findings: [
      merged({ ...finding('major', 'src/a.ts', 10), title: 'Missing null check on user' }, 'codex', 'claude'),
      merged({ ...finding('minor', 'src/b.ts', 5), title: 'Unused import' }, 'codex'),
      merged({ ...finding('minor', 'src/c.ts', 1), title: 'Typo in log' }, 'claude'),
    ],
  };

  test('matches by title when lines moved, by spot when titles differ, and lists the rest as fixed', () => {
    const now = [
      // Same bug, retitled and 30 lines down.
      merged({ ...finding('major', 'src/a.ts', 40), title: 'Null check missing for user input' }, 'claude'),
      // Same spot, different words: still the same finding unless the dimensions disagree.
      merged({ ...finding('minor', 'src/b.ts', 7), title: 'Dead code' }, 'codex'),
      merged({ ...finding('critical', 'src/d.ts', 2), title: 'SQL injection' }, 'codex', 'claude'),
    ];
    const report = trackFindings('bbbbbbbb2222', now, prior, ['codex', 'claude']);
    expect(report.prior).toBe('aaaaaaaa1111');
    expect(report.findings.map((f) => [f.title, f.status, f.since])).toEqual([
      ['Null check missing for user input', 'open', 'aaaaaaaa1111'],
      ['Dead code', 'open', 'aaaaaaaa1111'],
      ['SQL injection', 'new', undefined],
    ]);
    expect(report.fixed).toEqual([
      {
        severity: 'minor',
        file: 'src/c.ts',
        line: 1,
        title: 'Typo in log',
        reviewers: ['claude'],
        since: 'aaaaaaaa1111',
        lastSeen: 'aaaaaaaa1111',
      },
    ]);
  });

  test('a finding open since an earlier commit keeps that commit, and disagreeing dimensions keep two findings apart', () => {
    const older = {
      headSha: 'bbbbbbbb2222',
      findings: [
        {
          ...merged({ ...finding('major', 'src/a.ts', 10), dimension: 'security' }, 'codex'),
          status: 'open' as const,
          since: 'aaaaaaaa1111',
        },
      ],
    };
    const now = [
      merged({ ...finding('major', 'src/a.ts', 10), title: 'Totally different', dimension: 'testing' }, 'codex'),
      merged({ ...finding('major', 'src/a.ts', 11), title: 'major issue', dimension: 'security' }, 'claude'),
    ];
    const report = trackFindings('cccccccc3333', now, older, ['codex', 'claude']);
    expect(report.findings.map((f) => [f.title, f.status, f.since])).toEqual([
      ['Totally different', 'new', undefined],
      ['major issue', 'open', 'aaaaaaaa1111'],
    ]);
    expect(report.fixed).toEqual([]);
  });

  test('a prior finding whose reviewers all failed this time is carried forward, neither open nor fixed', () => {
    const report = trackFindings('bbbbbbbb2222', [], prior, ['claude']);
    // Claude ran and dropped its two; codex failed, so its lone finding is carried rather than called fixed.
    expect(report.fixed.map((f) => f.title)).toEqual(['Missing null check on user', 'Typo in log']);
    expect(report.carried).toEqual([
      { ...prior.findings[1]!, status: 'open', since: 'aaaaaaaa1111', lastSeen: 'aaaaaaaa1111' },
    ]);
    // Fixed on the review after that: linked where it was last seen, not at the review that carried it.
    const later = { headSha: 'bbbbbbbb2222', findings: [...report.findings, ...report.carried!] };
    expect(trackFindings('cccccccc3333', [], later, ['codex']).fixed).toMatchObject([
      { title: 'Unused import', since: 'aaaaaaaa1111', lastSeen: 'aaaaaaaa1111' },
    ]);
    const none = trackFindings('bbbbbbbb2222', [], prior, []);
    expect(none.fixed).toEqual([]);
    expect(none.carried?.map((f) => f.since)).toEqual(['aaaaaaaa1111', 'aaaaaaaa1111', 'aaaaaaaa1111']);
  });

  test('matchFindings takes title matches first, so a nearby stranger never steals a repeated finding', () => {
    const p1 = merged({ ...finding('major', 'src/a.ts', 10), title: 'Null deref on user' }, 'codex');
    const p2 = merged({ ...finding('minor', 'src/a.ts', 12), title: 'Unchecked index into users' }, 'codex');
    const stranger = merged({ ...finding('major', 'src/a.ts', 11), title: 'Totally other words' }, 'codex');
    const repeat = merged({ ...finding('major', 'src/a.ts', 40), title: 'Null pointer deref on user' }, 'codex');
    const matches = matchFindings([p1, p2], [stranger, repeat]);
    expect(matches.get(repeat)).toBe(p1);
    // The stranger falls back to the nearest prior left, whichever order the lists come in.
    expect(matches.get(stranger)).toBe(p2);
    expect(matchFindings([p2, p1], [repeat, stranger]).get(repeat)).toBe(p1);
  });

  test('a finding without a line matches on title alone, so two general remarks are not one finding', () => {
    const a = { ...finding('minor', 'src/a.ts', null), title: 'Missing tests for retries' };
    const b = { ...finding('minor', 'src/a.ts', null), title: 'Commit message vague' };
    expect(sameFinding(a, b)).toBe(false);
    expect(sameFinding(a, { ...a, line: 5 })).toBe(true);
    expect(sameFinding({ ...a, file: '' }, { ...b, file: '' })).toBe(false);
  });

  test('without a prior review nothing is marked', () => {
    const report = trackFindings('x', [merged(finding('minor'), 'codex')], null, ['codex']);
    expect(report).toEqual({ headSha: 'x', prior: null, findings: [merged(finding('minor'), 'codex')], fixed: [] });
  });
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

  test('shows agreement, dimension, what is new or still open, and what was fixed', () => {
    const tagged = { ...finding('major'), dimension: 'security' as const };
    const results = [result('codex', verdict(5, [tagged])), result('claude', verdict(5, [tagged]))];
    const merged = mergeFindings(results.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings })));
    const prior = {
      headSha: 'aaaaaaaa1111',
      findings: [
        { ...finding('minor', 'src/z.ts', 1), title: 'Stale comment', reviewers: ['codex'] },
        { ...tagged, reviewers: ['claude'], status: 'open' as const, since: '9999999900' },
      ],
    };
    const tracked = trackFindings(job.headSha, merged, prior, ['codex', 'claude']);
    const body = commentBody(job, results, stats, { tracked });
    expect(body).toContain('### Findings (1)\n\n<sub>Since `aaaaaaaa`: 0 new · 1 still open · 1 fixed</sub>');
    expect(body).toContain('- **Major · consensus** [`src/a.ts:10`]');
    expect(body).toContain('_(Codex, Claude · security)_ · open since `99999999`');
    expect(body).toContain('<details><summary>Fixed since `aaaaaaaa` (1)</summary>');
    // Linked at the prior commit, where the fixed finding's line still exists.
    expect(body).toContain('- ~~Minor [`src/z.ts:1`](https://github.com/Tyru5/Agendex/blob/aaaaaaaa1111/src/z.ts#L1)');
    expect(body).toContain('Stale comment~~ _(Codex, open since `aaaaaaaa`)_');
  });

  test('marks nothing when the PR has no earlier review, and a lone reviewer gets no agreement badge', () => {
    const body = commentBody(job, [result('claude', verdict(4, [finding('minor')]))], stats);
    expect(body).toContain('### Findings (1)\n\n- **Minor** [`src/a.ts:10`]');
    expect(body).not.toContain('Since `');
    expect(body).not.toContain(' · new');
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
