import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { reportDirFor } from '../src/report.ts';
import {
  diffCommand,
  listReports,
  outcomeOf,
  parseChangedLines,
  renderScorecard,
  renderScorecardNotes,
  scorecard,
  touched,
} from '../src/scorecard.ts';
import { styles } from '../src/ui.ts';
import type { Finding, MergedFinding } from '../src/verdict.ts';

const finding = (
  title: string,
  file: string,
  line: number | null,
  severity: Finding['severity'] = 'minor',
): Finding => ({
  severity,
  file,
  line,
  title,
  detail: 'd',
  suggestion: 's',
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@ fn
-old
+new
@@ -40 +41,0 @@
-gone
@@ -60,0 +61,2 @@
+added
+added
diff --git a/old name.ts b/new name.ts
similarity index 90%
rename from old name.ts
rename to new name.ts
--- a/old name.ts
+++ b/new name.ts
@@ -1 +1 @@
-x
+y
diff --git a/bin.png b/bin.png
Binary files differ
diff --git a/db/q.sql b/db/q.sql
--- a/db/q.sql
+++ b/db/q.sql
@@ -3 +2,0 @@
--- drop the old index first
@@ -40,2 +39 @@
-x
-y
+z
`;

describe('parseChangedLines and touched', () => {
  const changed = parseChangedLines(DIFF);

  test('reads old-side ranges per old path, including renames and binary files', () => {
    expect(changed.get('src/a.ts')).toEqual([
      [10, 11],
      [40, 40],
      [60, 60],
    ]);
    expect(changed.get('old name.ts')).toEqual([[1, 1]]);
    expect(changed.get('bin.png')).toEqual([]);
    expect(changed.has('new name.ts')).toBe(false);
    // A removed `-- ` comment line looks like a `---` header but is not one.
    expect(changed.get('db/q.sql')).toEqual([
      [3, 3],
      [40, 41],
    ]);
    expect(changed.has('drop the old index first')).toBe(false);
  });

  test('a finding is touched within 3 lines of a change, or anywhere in a changed file when it names no line', () => {
    expect(touched(changed, { file: 'src/a.ts', line: 14 })).toBe(true);
    expect(touched(changed, { file: 'src/a.ts', line: 15 })).toBe(false);
    expect(touched(changed, { file: 'src/a.ts', line: 57 })).toBe(true);
    expect(touched(changed, { file: 'src/a.ts', line: null })).toBe(true);
    expect(touched(changed, { file: 'bin.png', line: null })).toBe(true);
    expect(touched(changed, { file: 'src/b.ts', line: 1 })).toBe(false);
  });

  test('outcomeOf: moved lines are addressed or attempted, still lines ignored or dropped, no diff unknown', () => {
    const f: MergedFinding = { ...finding('Off by one', 'src/a.ts', 11), reviewers: ['codex'] };
    const again: MergedFinding = { ...finding('Off-by-one error', 'src/a.ts', 12), reviewers: ['codex'] };
    const still: MergedFinding = { ...finding('Unused import', 'src/a.ts', 100), reviewers: ['codex'] };
    expect(outcomeOf(f, false, changed)).toBe('addressed');
    expect(outcomeOf(f, true, changed)).toBe('attempted');
    expect(outcomeOf(still, true, changed)).toBe('ignored');
    expect(outcomeOf(still, false, changed)).toBe('dropped');
    expect(outcomeOf(f, false, null)).toBe('unknown');
    // A finding without a file has no lines to watch.
    expect(outcomeOf({ ...f, file: '' }, false, changed)).toBe('unknown');
    expect(again).toBeDefined();
  });

  test('the diff ignores git settings that would hide hunks or rename paths: external diff, textconv, quoting, prefixes', () => {
    const cmd = diffCommand('/clone', 'aaa', 'bbb');
    expect(cmd.slice(0, 3)).toEqual(['git', '-C', '/clone']);
    expect(cmd.indexOf('core.quotePath=false')).toBeLessThan(cmd.indexOf('diff'));
    for (const flag of [
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ])
      expect(cmd).toContain(flag);
    expect(cmd.slice(-2)).toEqual(['aaa', 'bbb']);
  });

  test('a report folder whose PR number can’t be read is left out rather than grouped with others', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const dir = join(dataDir, 'reports', 'o__r', 'pr-oops', 'aaaaaaaa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ repo: 'o/r', headSha: 'aaaaaaaa1', reviewers: [] }));
    expect(listReports(dataDir)).toEqual([]);
  });
});

/** A PR review's report folder, as the runner writes it. */
function report(
  dataDir: string,
  job: { repo: string; pr: number; headSha: string },
  finishedAt: string,
  reviewers: Record<string, { score: number; findings: Finding[]; costUsd?: number; failed?: boolean }>,
) {
  const dir = reportDirFor(dataDir, job);
  mkdirSync(dir, { recursive: true });
  const meta = Object.entries(reviewers).map(([name, r]) => ({
    name,
    harness: name,
    ok: !r.failed,
    score: r.failed ? undefined : r.score,
    durationMs: 1,
    ...(r.costUsd === undefined
      ? {}
      : {
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1,
            costUsd: r.costUsd,
            costSource: 'reported',
          },
        }),
  }));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...job, finishedAt, reviewers: meta }));
  for (const [name, r] of Object.entries(reviewers)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ score: r.score, verdict: { findings: r.findings } }));
  }
}

describe('scorecard', () => {
  const config = parseConfig({
    repos: [{ fullName: 'o/r', localPath: '/clone/r' }],
    reviewers: ['codex', 'claude'],
  });

  test('judges each reviewer’s findings by the next review of the PR, with cost per addressed finding', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const pr7 = (sha: string) => ({ repo: 'o/r', pr: 7, headSha: sha });
    const shared = finding('Null deref', 'src/a.ts', 10, 'major');
    report(dataDir, pr7('aaaaaaaa1'), '2026-10-01T00:00:00Z', {
      codex: {
        score: 3,
        findings: [shared, finding('Unused import', 'src/a.ts', 100), finding('Flaky', 'src/c.ts', 5)],
        costUsd: 4,
      },
      claude: {
        score: 5,
        findings: [{ ...shared, line: 12 }, finding('Weak test', 'test/a.test.ts', null, 'major')],
        costUsd: 2,
      },
    });
    report(dataDir, pr7('bbbbbbbb2'), '2026-10-02T00:00:00Z', {
      codex: { score: 4, findings: [finding('Unused import', 'src/a.ts', 100)] },
      claude: { score: 5, findings: [finding('Test still weak', 'test/a.test.ts', null, 'major')] },
    });
    // A lone review of another PR: nothing follows it, so it is not judged.
    report(dataDir, { repo: 'o/r', pr: 8, headSha: 'cccccccc3' }, '2026-10-03T00:00:00Z', {
      codex: { score: 2, findings: [finding('Lonely', 'x.ts', 1)] },
    });
    // A repo the config doesn't know: its pair can't be diffed.
    report(dataDir, { repo: 'o/other', pr: 1, headSha: 'dddddddd4' }, '2026-10-01T00:00:00Z', {
      codex: { score: 4, findings: [finding('Mystery', 'y.ts', 1)] },
    });
    report(dataDir, { repo: 'o/other', pr: 1, headSha: 'eeeeeeee5' }, '2026-10-02T00:00:00Z', {
      codex: { score: 4, findings: [] },
    });

    const diffs: string[] = [];
    const card = await scorecard(config, listReports(dataDir), {
      diff: async (localPath, prior, next) => {
        diffs.push(`${localPath} ${prior} ${next}`);
        return 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,1 @@\n-x\n-y\n+z\ndiff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-a\n+b\n';
      },
    });
    expect(diffs).toEqual(['/clone/r aaaaaaaa1 bbbbbbbb2']);
    expect(card).toMatchObject({ reviews: 5, pairs: 2, unknownPairs: 1 });
    const [codex, claude] = card.reviewers;
    expect(codex).toMatchObject({
      name: 'codex',
      reviews: 2,
      findings: 4,
      outcomes: { addressed: 1, attempted: 0, ignored: 1, dropped: 1, unknown: 1 },
      unique: { findings: 2, addressed: 0 },
      agreed: 1,
      severe: { findings: 1, ignored: 0, dropped: 0 },
    });
    expect(codex!.scoreDelta).toBeCloseTo(-1);
    expect(codex!.cost?.costUsd).toBe(4);
    expect(claude).toMatchObject({
      name: 'claude',
      reviews: 1,
      findings: 2,
      // The null-line test finding's file changed but the finding came back, retitled: attempted.
      outcomes: { addressed: 1, attempted: 1, ignored: 0, dropped: 0, unknown: 0 },
      unique: { findings: 1, addressed: 0 },
      agreed: 1,
      severe: { findings: 2, ignored: 0, dropped: 0 },
    });
    expect(claude!.scoreDelta).toBeCloseTo(1);

    const table = renderScorecard(card, { color: false });
    expect(table[0]).toContain('REVIEWER  REVIEWS  FINDINGS');
    expect(table[1]).toContain('codex     2        4 (1 unknown)  1 (33%)');
    expect(table[1]).toContain('$4.00');
    expect(table[2]).toContain('claude    1        2              1 (50%)    1 (50%)');
    const notes = renderScorecardNotes(card, styles(false)).join('\n');
    expect(notes).toContain('2 pairs of reviews');
    expect(notes).not.toContain('rated');
    expect(notes).toContain('1 pair could not be diffed');
  });

  test('a review where every reviewer failed is skipped, and a reviewer that failed cannot repeat a finding', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const pr = (sha: string) => ({ repo: 'o/r', pr: 9, headSha: sha });
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', {
      codex: { score: 3, findings: [finding('Codex bug', 'src/a.ts', 1)] },
      claude: { score: 3, findings: [finding('Claude bug', 'src/a.ts', 50)] },
    });
    // Every reviewer failed: this review neither judges the first nor is judged by the third.
    report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', { codex: { score: 0, findings: [], failed: true } });
    report(dataDir, pr('cccccccc3'), '2026-10-03T00:00:00Z', {
      codex: { score: 0, findings: [], failed: true },
      claude: { score: 4, findings: [] },
    });
    const diffs: string[] = [];
    const card = await scorecard(config, listReports(dataDir), {
      diff: async (_p, prior, next) => {
        diffs.push(`${prior}..${next}`);
        return '';
      },
    });
    expect(diffs).toEqual(['aaaaaaaa1..cccccccc3']);
    expect(card.pairs).toBe(1);
    const [codex, claude] = card.reviewers;
    // Codex failed on the third commit, so its finding waits for a later pair; Claude's is dropped.
    expect(codex!.findings).toBe(0);
    expect(claude!.outcomes).toMatchObject({ dropped: 1, unknown: 0 });
  });

  test('two of four reviewers agreeing is not unique, and the comment and scorecard match findings the same way', async () => {
    const four = parseConfig({
      repos: [{ fullName: 'o/r', localPath: '/clone/r' }],
      reviewers: ['codex', 'claude', 'gemini', 'copilot'],
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const pr = (sha: string) => ({ repo: 'o/r', pr: 3, headSha: sha });
    const shared = finding('Null deref on user', 'src/a.ts', 10, 'major');
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', {
      codex: { score: 3, findings: [shared, finding('Unchecked index into users', 'src/a.ts', 12)] },
      claude: { score: 3, findings: [shared] },
      gemini: { score: 4, findings: [] },
      copilot: { score: 4, findings: [] },
    });
    // One finding that reads like the null deref; lines unchanged. One-to-one matching gives it to the null deref,
    // so the index finding is dropped, as the comment would list it fixed, rather than ignored.
    report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', {
      codex: { score: 3, findings: [finding('Null pointer deref on user', 'src/a.ts', 11, 'major')] },
      claude: { score: 4, findings: [] },
      gemini: { score: 4, findings: [] },
      copilot: { score: 4, findings: [] },
    });
    const card = await scorecard(four, listReports(dataDir), { diff: async () => '' });
    const codex = card.reviewers.find((r) => r.name === 'codex')!;
    const claude = card.reviewers.find((r) => r.name === 'claude')!;
    expect(codex).toMatchObject({
      unique: { findings: 1, addressed: 0 },
      agreed: 1,
      outcomes: { ignored: 1, dropped: 1 },
    });
    expect(claude).toMatchObject({ unique: { findings: 0, addressed: 0 }, agreed: 1, outcomes: { ignored: 1 } });
  });

  test('a finding carried through a failed run is judged in the pair where its reviewer runs again, as the comment does', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const pr = (sha: string) => ({ repo: 'o/r', pr: 5, headSha: sha });
    const y = finding('Race in cache eviction', 'src/a.ts', 10);
    const x = finding('Unused import', 'src/a.ts', 50);
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { claude: { score: 4, findings: [y] } });
    // Claude fails on B; codex reports X. B's review carries Y forward.
    const b = reportDirFor(dataDir, pr('bbbbbbbb2'));
    report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', {
      claude: { score: 0, findings: [], failed: true },
      codex: { score: 4, findings: [x] },
    });
    writeFileSync(
      join(b, 'findings.json'),
      JSON.stringify({
        headSha: 'bbbbbbbb2',
        prior: 'aaaaaaaa1',
        findings: [{ ...x, reviewers: ['codex'], status: 'new' }],
        fixed: [],
        carried: [{ ...y, reviewers: ['claude'], status: 'open', since: 'aaaaaaaa1', lastSeen: 'aaaaaaaa1' }],
      }),
    );
    // C: claude reports Y retitled at X's line; codex reports nothing. By title, that is Y; X is fixed.
    report(dataDir, pr('cccccccc3'), '2026-10-03T00:00:00Z', {
      claude: { score: 4, findings: [finding('Race in cache', 'src/a.ts', 50)] },
      codex: { score: 5, findings: [] },
    });
    const diffs: string[] = [];
    const card = await scorecard(config, listReports(dataDir), {
      diff: async (_p, prior, next) => {
        diffs.push(`${prior}..${next}`);
        return '';
      },
    });
    const codex = card.reviewers.find((r) => r.name === 'codex')!;
    const claude = card.reviewers.find((r) => r.name === 'claude')!;
    // Pair A→B: claude failed, so Y waits. Pair B→C: Y (carried) is repeated, lines unchanged → ignored; X dropped.
    expect(claude.outcomes).toMatchObject({ ignored: 1, dropped: 0, unknown: 0 });
    expect(codex.outcomes).toMatchObject({ dropped: 1, ignored: 0 });
    // Y's line numbers hold at A, where it was last seen, so it is diffed from A, not from B. Pair A→B judges
    // nothing (claude failed), so it runs no diff and counts as unknown for nothing.
    expect(diffs.toSorted()).toEqual(['aaaaaaaa1..cccccccc3', 'bbbbbbbb2..cccccccc3']);
    expect(card.unknownPairs).toBe(0);
  });

  test('a carried finding whose lines moved before the carrying commit is still seen as addressed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    const pr = (sha: string) => ({ repo: 'o/r', pr: 6, headSha: sha });
    const y = finding('Race in cache eviction', 'src/a.ts', 10);
    report(dataDir, pr('aaaaaaaa1'), '2026-10-01T00:00:00Z', { claude: { score: 4, findings: [y] } });
    report(dataDir, pr('bbbbbbbb2'), '2026-10-02T00:00:00Z', {
      claude: { score: 0, findings: [], failed: true },
      codex: { score: 4, findings: [] },
    });
    writeFileSync(
      join(reportDirFor(dataDir, pr('bbbbbbbb2')), 'findings.json'),
      JSON.stringify({
        headSha: 'bbbbbbbb2',
        prior: 'aaaaaaaa1',
        findings: [],
        fixed: [],
        carried: [{ ...y, reviewers: ['claude'], status: 'open', since: 'aaaaaaaa1', lastSeen: 'aaaaaaaa1' }],
      }),
    );
    report(dataDir, pr('cccccccc3'), '2026-10-03T00:00:00Z', {
      claude: { score: 5, findings: [] },
      codex: { score: 5, findings: [] },
    });
    // B inserted 20 lines above Y, so the fix in C touches line 30 of B but line 10 of A.
    const hunk = (line: number) =>
      `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -${line} +${line} @@\n-x\n+y\n`;
    const card = await scorecard(config, listReports(dataDir), {
      diff: async (_p, prior) => (prior === 'aaaaaaaa1' ? hunk(10) : hunk(30)),
    });
    expect(card.reviewers.find((r) => r.name === 'claude')!.outcomes).toMatchObject({ addressed: 1, dropped: 0 });
  });

  test('says so when no PR has two reviews, and lists configured reviewers with nothing judged', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-scorecard-'));
    report(dataDir, { repo: 'o/r', pr: 1, headSha: 'aaaaaaaa1' }, '2026-10-01T00:00:00Z', {
      codex: { score: 4, findings: [] },
    });
    const card = await scorecard(config, listReports(dataDir), { diff: async () => '' });
    expect(card.pairs).toBe(0);
    expect(card.reviewers.map((r) => r.name)).toEqual(['codex', 'claude']);
    expect(renderScorecard(card, { color: false })).toEqual([
      'no PR has two reviewed commits yet, so there is nothing to judge findings against',
    ]);
  });
});
