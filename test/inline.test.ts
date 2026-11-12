import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execOrThrow } from '../src/exec.ts';
import { addedLines, INLINE_MARKER, planInline, unposted, type InlineComment } from '../src/inline.ts';
import type { TrackedFinding } from '../src/lifecycle.ts';

const SHA = '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0';
const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('addedLines', () => {
  test('reads the added lines of each file from a real diff, whatever the user diff settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-inline-'));
    try {
      const git = (...args: string[]) => execOrThrow(['git', '-C', dir, ...args]);
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 't@example.com');
      await git('config', 'user.name', 't');
      // Without pinned prefixes, b/x.ts would print as `+++ b/x.ts` and read as x.ts.
      await git('config', 'diff.noprefix', 'true');
      writeFileSync(join(dir, 'a.ts'), lines(10));
      writeFileSync(join(dir, 'old name.ts'), lines(20, 'keep'));
      writeFileSync(join(dir, 'gone.ts'), lines(3));
      mkdirSync(join(dir, 'b'));
      writeFileSync(join(dir, 'b', 'x.ts'), lines(2));
      await git('add', '.');
      await git('commit', '-qm', 'base');
      await git('switch', '-qc', 'feat');
      // a.ts: line 3 changed, two lines added after 7 (new lines 8 and 9), line 10 removed.
      writeFileSync(
        join(dir, 'a.ts'),
        ['line 1', 'line 2', 'line three', 'line 4', 'line 5', 'line 6', 'line 7', 'new 8', 'new 9', 'line 8', 'line 9']
          .join('\n')
          .concat('\n'),
      );
      // A rename with a space in its name and one edit, so the diff names the new path.
      rmSync(join(dir, 'old name.ts'));
      writeFileSync(join(dir, 'new name.ts'), lines(20, 'keep').replace('keep 5\n', 'kept 5\n'));
      rmSync(join(dir, 'gone.ts'));
      writeFileSync(join(dir, 'b', 'x.ts'), lines(3));
      await git('add', '-A');
      await git('commit', '-qm', 'feat');

      const added = await addedLines(dir, 'main', 'HEAD');
      expect([...added.keys()].toSorted()).toEqual(['a.ts', 'b/x.ts', 'new name.ts']);
      expect([...added.get('b/x.ts')!]).toEqual([3]);
      expect([...added.get('a.ts')!].toSorted((x, y) => x - y)).toEqual([3, 8, 9]);
      expect([...added.get('new name.ts')!]).toEqual([5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const finding = (overrides: Partial<TrackedFinding> = {}): TrackedFinding => ({
  severity: 'major',
  dimension: 'correctness',
  file: 'src/a.ts',
  line: 10,
  title: 'Off by one',
  detail: 'Skips the last item.',
  suggestion: 'Use <= instead of <.',
  reviewers: ['claude', 'codex'],
  agreement: 'consensus',
  ...overrides,
});

const labels = new Map([
  ['claude', 'Claude'],
  ['codex', 'Codex'],
]);

describe('planInline', () => {
  const added = new Map([['src/a.ts', new Set([10, 11, 12, 20])]]);
  const plan = (f: TrackedFinding) => planInline([f], added, labels);

  test('comments on new findings at added lines only', () => {
    expect(plan(finding()).map((c) => [c.path, c.line, c.start_line])).toEqual([['src/a.ts', 10, undefined]]);
    expect(plan(finding({ status: 'new' }))).toHaveLength(1);
    // Already commented on when it was new.
    expect(plan(finding({ status: 'open', since: SHA }))).toEqual([]);
    // A context or untouched line, no line at all, and a file outside the diff stay in the summary.
    expect(plan(finding({ line: 13 }))).toEqual([]);
    expect(plan(finding({ line: null }))).toEqual([]);
    expect(plan(finding({ file: 'src/b.ts' }))).toEqual([]);
  });

  test('a range of added lines gets a multi-line comment and its suggestion; a broken range gets neither', () => {
    const [range] = plan(finding({ endLine: 12, replacement: 'a\nb\nc\n' }));
    expect(range).toMatchObject({ path: 'src/a.ts', start_line: 10, start_side: 'RIGHT', line: 12, side: 'RIGHT' });
    // The trailing newline would apply as a blank line.
    expect(range!.body).toContain('```suggestion\na\nb\nc\n```');

    // Line 13 isn't added, so the range can't be commented on whole: the first line alone, with no suggestion.
    const [broken] = plan(finding({ endLine: 13, replacement: 'x' }));
    expect(broken).toMatchObject({ line: 10 });
    expect(broken!.start_line).toBeUndefined();
    expect(broken!.body).not.toContain('suggestion\n');
  });

  test('the body carries the badge, reviewers, dimension, detail, fix, and marker; a fence outlasts backticks', () => {
    const [c] = plan(finding({ replacement: 'const s = ```x```;' }));
    expect(c!.body).toBe(
      [
        '**Major · consensus** Off by one',
        '<sub>Claude, Codex · correctness</sub>',
        '',
        'Skips the last item.',
        '',
        '**Suggested fix:** Use <= instead of <.',
        '',
        '````suggestion',
        'const s = ```x```;',
        '````',
        '',
        INLINE_MARKER,
      ].join('\n'),
    );
    // An empty replacement deletes the line, which is a real suggestion.
    expect(plan(finding({ replacement: '' }))[0]!.body).toContain('```suggestion\n\n```');
  });
});

describe('unposted', () => {
  const planned: InlineComment[] = [
    { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'x' },
    { path: 'src/a.ts', line: 30, side: 'RIGHT', body: 'y' },
  ];

  test('drops spots already commented on this commit, within 3 lines', () => {
    const kept = unposted(
      planned,
      [
        { path: 'src/a.ts', original_line: 13, original_commit_id: SHA },
        // An older commit, another file, and a file-level comment don't count.
        { path: 'src/a.ts', original_line: 30, original_commit_id: 'b'.repeat(40) },
        { path: 'src/b.ts', original_line: 30, original_commit_id: SHA },
        { path: 'src/a.ts', original_line: null, original_commit_id: SHA },
      ],
      SHA,
    );
    expect(kept.map((c) => c.line)).toEqual([30]);
    expect(unposted(planned, [{ path: 'src/a.ts', original_line: 14, original_commit_id: SHA }], SHA)).toEqual(planned);
  });
});
