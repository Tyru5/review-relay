import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, THEMES } from '../src/config.ts';
import type { DaemonState } from '../src/daemon.ts';
import { reportDirFor } from '../src/report.ts';
import type { JobRecord } from '../src/state.ts';
import { clip, colorDepth, fill, frame, moved, pan, parseKeys, rgb } from '../src/term.ts';
import {
  initialState,
  JobStore,
  MIN_SIZE,
  perform,
  prUrl,
  readJobs,
  reduce,
  renderTui,
  themeStyles,
  visible,
  type TuiContext,
  type TuiState,
} from '../src/tui.ts';
import { visibleLength } from '../src/ui.ts';

const job = (sha: string, patch: Partial<JobRecord> = {}): JobRecord => ({
  key: `acme/app@${sha}`,
  repo: 'acme/app',
  pr: 7,
  headSha: sha,
  source: 'github',
  status: 'done',
  startedAt: '2026-10-02T10:00:00.000Z',
  finishedAt: '2026-10-02T10:02:05.000Z',
  ...patch,
});

const RUNNING = job('aaaaaaaa1', { status: 'running', startedAt: '2026-10-02T11:00:00.000Z', finishedAt: undefined });
const DONE = job('bbbbbbbb2');
const FAILED = job('cccccccc3', {
  repo: 'acme/lib',
  pr: 12,
  status: 'failed',
  error: 'codex: timed out after 1800s',
  startedAt: '2026-10-02T09:00:00.000Z',
  route: 'risky',
});
const SKIPPED = job('dddddddd4', { status: 'skipped', pr: 3, startedAt: '2026-10-02T08:00:00.000Z' });
const NOW = Date.parse('2026-10-02T11:03:30.000Z');

const finding = (severity: string, line: number, title: string) => ({
  severity,
  file: 'src/a.ts',
  line,
  title,
  detail: 'why it matters',
  suggestion: 'fix it',
});

/** Twelve finished jobs on one PR, newest first, for scrolling. */
const MANY = Array.from({ length: 12 }, (_, i) =>
  job(`${i}`.padStart(8, 'e'), { pr: 100 + i, startedAt: `2026-10-01T${String(23 - i).padStart(2, '0')}:00:00.000Z` }),
);

/** Every temp folder a test made, removed after it. */
const made: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data folder with the four jobs, a report for the done one, and a daemon log naming two of them. */
function dataDir(jobs: JobRecord[] = [FAILED, DONE, RUNNING, SKIPPED]) {
  const dir = tempDir('relay-tui-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(jobs));
  const report = reportDirFor(dir, DONE);
  mkdirSync(report, { recursive: true });
  writeFileSync(
    join(report, 'meta.json'),
    JSON.stringify({
      baseRef: 'main',
      score: 3,
      reviewers: [
        { name: 'codex', ok: true, score: 4, durationMs: 65_000, model: 'gpt-6-astra', effort: 'high' },
        { name: 'claude', ok: true, score: 3, durationMs: 90_000, model: 'claude-opus-5-5' },
      ],
    }),
  );
  writeFileSync(
    join(report, 'codex.json'),
    JSON.stringify({
      score: 4,
      verdict: { findings: [finding('major', 3, 'Null deref'), finding('minor', 40, 'Typo')] },
    }),
  );
  writeFileSync(
    join(report, 'claude.json'),
    JSON.stringify({ score: 3, verdict: { findings: [finding('major', 4, 'Null deref')] } }),
  );
  writeFileSync(
    join(report, 'comment.md'),
    '<!-- review-relay -->\n## review-relay: 3/5\n\nLooks \x1b[31mok\x1b[0m.\n\n',
  );
  writeFileSync(
    join(dir, 'daemon.log'),
    [
      ...Array.from({ length: 8 }, (_, i) => `10:5${i}:00 forwarder acme/app: event ${i}`),
      '11:00:00 [acme/app] PR #7 @ aaaaaaaa: reviewing (opened)',
      '09:00:00 [acme/lib] PR #12 @ cccccccc: reviewing (opened)',
      '09:30:00 [acme/lib] PR #12: failed: codex: timed out after 1800s',
      '11:00:01 server listening on 127.0.0.1:9988',
    ].join('\n') + '\n',
  );
  return dir;
}

const DAEMON: DaemonState = {
  running: true,
  pid: 4242,
  stale: false,
  port: 9988,
  uptimeMs: 7_500_000,
  startedAt: null,
  version: '0.6.0',
  health: 'ok',
  forwarders: [
    { repo: 'acme/app', pid: 1, events: 'pull_request', since: '', restarts: 0, alive: true },
    { repo: 'acme/lib', pid: 2, events: 'pull_request', since: '', restarts: 0, alive: false },
  ],
  foreign: false,
};

function ctxFor(dir = dataDir(), patch: Partial<TuiContext> = {}): TuiContext {
  const store = new JobStore(dir);
  store.refresh();
  return { store, daemon: DAEMON, reviewers: ['codex', 'claude'], now: NOW, height: 30, width: 160, ...patch };
}

const press = (ctx: TuiContext, keys: string[], state: TuiState = initialState()) =>
  keys.reduce((s, key) => reduce(s, key, ctx), state);

const lines = (state: TuiState, ctx: TuiContext) => renderTui(state, ctx, themeStyles(false), '0.6.0');
const render = (state: TuiState, ctx: TuiContext) => lines(state, ctx).join('\n');

describe('readJobs and JobStore', () => {
  test('PR state refreshes independently of review status and is shared across commits, not repos', async () => {
    const other = job('other', { repo: 'acme/lib' });
    const dir = dataDir([DONE, RUNNING, other]);
    let merged = false;
    const store = new JobStore(dir, async (repo) => (repo === 'acme/lib' ? 'closed' : merged ? 'merged' : 'open'));
    store.refresh();
    const ctx = ctxFor(dir, { store });
    expect(render(initialState(), ctx)).toMatch(/done\s+unknown/);
    await store.refreshPrStates(store.jobs, NOW);
    expect(render(initialState(), ctx)).toMatch(/done\s+open/);
    expect(store.prState(other)).toBe('closed');

    merged = true;
    await store.refreshPrStates(store.jobs, NOW + 59_999);
    expect(store.prState(DONE)).toBe('open');
    await store.refreshPrStates(store.jobs, NOW + 60_000);
    expect(store.prState(DONE)).toBe('merged');
    expect(store.prState(RUNNING)).toBe('merged');
    expect(store.prState(other)).toBe('closed');
    expect(render(initialState(), ctx)).toMatch(/done\s+merged/);
    expect(render(press(ctx, ['down', 'enter']), ctx)).toContain('PR merged');
    expect(store.jobs.find((j) => j.key === DONE.key)?.status).toBe('done');
    expect(readJobs(join(dir, 'state.json')).find((j) => j.key === DONE.key)?.status).toBe('done');
    // Later state-file reloads cannot lose a known merge, and merged PRs need no more requests.
    writeFileSync(join(dir, 'state.json'), JSON.stringify([DONE]));
    store.refresh();
    merged = false;
    await store.refreshPrStates(store.jobs, NOW + 120_000);
    expect(store.prState(DONE)).toBe('merged');
  });

  test('failed PR checks show unknown, retry later, and never query local reviews', async () => {
    const local = job('local', { source: 'local', pr: 0, branch: 'feature' });
    let offline = true;
    const requested: number[] = [];
    const store = new JobStore(dataDir([DONE, local]), async (_repo, pr) => {
      requested.push(pr);
      if (offline) throw new Error('offline');
      return 'open';
    });
    store.refresh();
    await store.refreshPrStates(store.jobs, NOW);
    expect(store.prState(DONE)).toBe('unknown');
    expect(store.prState(local)).toBeUndefined();
    offline = false;
    await store.refreshPrStates(store.jobs, NOW + 59_999);
    expect(store.prState(DONE)).toBe('unknown');
    await store.refreshPrStates(store.jobs, NOW + 60_000);
    expect(store.prState(DONE)).toBe('open');
    offline = true;
    await store.refreshPrStates(store.jobs, NOW + 120_000);
    expect(store.prState(DONE)).toBe('unknown');
    expect(requested).toEqual([7, 7, 7]);
    const ctx = ctxFor(store.dataDir, { store });
    expect(render(initialState(), ctx)).toMatch(/done\s+-\s+.*feature/);
    expect(render({ ...initialState(), view: 'detail', selected: local.key }, ctx)).not.toContain('PR unknown');
  });

  test('concurrent refreshes deduplicate PRs and bound GitHub requests', async () => {
    let active = 0;
    let peak = 0;
    const requested: number[] = [];
    const store = new JobStore(dataDir(), async (_repo, pr) => {
      requested.push(pr);
      peak = Math.max(peak, ++active);
      await Bun.sleep(5);
      active--;
      return 'merged';
    });
    const jobs = [...MANY, { ...MANY[0]!, key: 'another-commit' }];
    await Promise.all([store.refreshPrStates(jobs, NOW), store.refreshPrStates(jobs, NOW)]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(requested.toSorted()).toEqual(MANY.map((j) => j.pr).toSorted());
    expect(jobs.every((j) => store.prState(j) === 'merged')).toBe(true);
  });

  test('keeps running jobs as running and sorts newest first, unlike StateStore', () => {
    const dir = dataDir();
    expect(readJobs(join(dir, 'state.json')).map((j) => [j.status, j.headSha])).toEqual([
      ['running', 'aaaaaaaa1'],
      ['done', 'bbbbbbbb2'],
      ['failed', 'cccccccc3'],
      ['skipped', 'dddddddd4'],
    ]);
    expect(readJobs(join(dir, 'missing.json'))).toEqual([]);
    writeFileSync(join(dir, 'state.json'), JSON.stringify([{ nope: true }, 'x', null, RUNNING]));
    expect(readJobs(join(dir, 'state.json'))).toHaveLength(1);
  });

  test('refresh reloads only when the file changed, and the detail reads the report folder once', () => {
    const dir = dataDir();
    const store = new JobStore(dir);
    expect(store.refresh()).toBe(true);
    expect(store.refresh()).toBe(false);
    writeFileSync(join(dir, 'state.json'), JSON.stringify([DONE]));
    expect(store.refresh()).toBe(true);
    expect(store.jobs).toHaveLength(1);
    const detail = store.detail(DONE);
    expect(detail.summary?.score).toBe(3);
    expect(detail.findings.map((f) => [f.severity, f.title, f.reviewers])).toEqual([
      ['major', 'Null deref', ['codex', 'claude']],
      ['minor', 'Typo', ['codex']],
    ]);
    // The marker line is dropped, escapes are stripped, trailing blanks go.
    expect(detail.comment).toEqual(['## review-relay: 3/5', '', 'Looks ok.']);
    expect(store.detail(DONE)).toBe(detail);
    expect(store.report(RUNNING)).toBeNull();
    expect(store.detail(SKIPPED).summary).toBeNull();
  });

  test('a re-run of the same commit drops the cached report and detail', () => {
    const dir = dataDir([DONE]);
    const store = new JobStore(dir);
    store.refresh();
    expect(store.detail(DONE).summary?.score).toBe(3);
    expect(store.report(DONE)?.score).toBe(3);
    // The re-run starts: same key, back to running; nothing cached applies.
    const again = { ...DONE, status: 'running' as const, startedAt: '2026-10-02T12:00:00.000Z', finishedAt: undefined };
    writeFileSync(join(dir, 'state.json'), JSON.stringify([again]));
    store.refresh();
    expect(store.report(again)).toBeNull();
    expect(store.detail(again).summary).toBeNull();
    // It finishes with a new report in the same folder, which is read afresh.
    const report = reportDirFor(dir, DONE);
    writeFileSync(join(report, 'meta.json'), JSON.stringify({ score: 5, reviewers: [] }));
    const finished = { ...again, status: 'done' as const, finishedAt: '2026-10-02T12:03:00.000Z' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify([finished]));
    store.refresh();
    expect(store.report(finished)?.score).toBe(5);
    expect(store.detail(finished).summary?.score).toBe(5);
    // Caching still holds while nothing about the job changed.
    expect(store.detail(finished)).toBe(store.detail(finished));
  });

  test('log narrows the daemon log to one job by its repo tag and PR number', () => {
    const store = new JobStore(dataDir());
    expect(store.log(FAILED)).toEqual([
      '09:00:00 [acme/lib] PR #12 @ cccccccc: reviewing (opened)',
      '09:30:00 [acme/lib] PR #12: failed: codex: timed out after 1800s',
    ]);
    expect(store.log()).toHaveLength(12);
    expect(store.log(SKIPPED)).toEqual([]);
    // PR #12's view doesn't pick up PR #120 or #1.
    writeFileSync(
      join(store.dataDir, 'daemon.log'),
      '09:40:00 [acme/lib] PR #120 @ ffffffff: reviewing (opened)\n09:41:00 [acme/lib] PR #1 @ 11111111: reviewing\n',
      { flag: 'a' },
    );
    expect(store.log(FAILED)).toHaveLength(2);
    expect(store.log({ ...FAILED, pr: 1 })).toEqual(['09:41:00 [acme/lib] PR #1 @ 11111111: reviewing']);
    expect(new JobStore(tempDir('relay-empty-')).log()).toEqual([]);
  });
});

describe('frame', () => {
  test('fills the terminal edge to edge: header, status, panels, message, footer', () => {
    const ctx = ctxFor();
    const frame = lines(initialState(), ctx);
    expect(frame).toHaveLength(30);
    for (const line of frame) expect(visibleLength(line)).toBe(160);
    expect(frame[0]).toMatch(/^ ◆ REVIEW-RELAY {3}1 Jobs {3}2 Log {3}\[t] dark\s+\/tmp\/relay-tui-\S+ · v0\.6\.0 $/);
    expect(frame[1]).toContain(
      '✓ daemon running  pid 4242 · up 2h05m · 1/2 forwarders  │  4 jobs · 1 running · 1 done · 1 failed · 1 skipped',
    );
    expect(frame[2]).toMatch(/^╭─ Jobs ─+ 1 of 4 {2}\[\/] filter {3}\[s] status ─╮$/);
    expect(frame[3]).toMatch(
      /^│ {3}STATUS\s+PR STATE\s+STARTED\s+TIME\s+REPO\s+PR\s+COMMIT\s+SOURCE\s+ROUTE\s+SCORE\s+CODEX\s+CLAUDE.*│$/,
    );
    expect(frame[4]).toMatch(/^│ ▌ running\s+unknown\s+10-02 \d\d:00\s+3m30s\s+acme\/app\s+#7\s+aaaaaaaa/);
    expect(frame[5]).toMatch(
      /^│ {3}done\s+.*acme\/app\s+#7\s+bbbbbbbb\s+github\s+-\s+3\/5\s+4\/5 1m05s\s+3\/5 1m30s\s+0\s+1\s+1/,
    );
    expect(frame[6]).toMatch(/^│ {3}failed\s+.*acme\/lib\s+#12.*risky.*codex: timed out/);
    expect(frame[8]).toMatch(/^╰─+╯$/);
    // The highlighted job's detail sits under the table.
    expect(frame[9]).toMatch(/^╭─ Job · acme\/app #7 ─+ \[enter] expand ─╮$/);
    expect(frame[10]).toContain('│ acme/app #7  aaaaaaaa  ! running');
    expect(frame[28]).toBe(' '.repeat(160));
    expect(frame[29]).toBe(
      ' [↑↓] move   [enter] open   [l] log   [r] re-run   [o] open PR   [y] copy url   [/] filter   [s] status   [?] help   [q] quit'.padEnd(
        160,
      ),
    );
  });

  test('in color, every row carries the page background and reopens it after each reset', () => {
    const ctx = ctxFor();
    const st = themeStyles(true);
    const frame = renderTui(initialState(), ctx, st, '0.6.0');
    const page = `\x1b[48;2;13;20;33;38;2;222;231;242m`;
    for (const line of frame) {
      expect(line.startsWith(page)).toBe(true);
      expect(line.endsWith('\x1b[0m')).toBe(true);
      expect(visibleLength(line)).toBe(160);
      // Every reset is followed by some background again, so no cell shows the terminal's own color.
      expect(line.replaceAll(`\x1b[0m\x1b[48;2;`, '').split('\x1b[0m').length).toBe(2);
    }
    expect(frame[4]).toContain(`\x1b[48;2;29;61;70;38;2;79;209;197m`);
  });

  test('strips terminal escapes from reviewer-written paths and errors', () => {
    const dir = dataDir([DONE, { ...FAILED, error: 'codex: \x1b]52;c;ZXZpbA==\x07timed out \x1b[31mred\x1b[0m' }]);
    writeFileSync(
      join(reportDirFor(dir, DONE), 'codex.json'),
      JSON.stringify({
        score: 4,
        verdict: {
          findings: [{ ...finding('major', 3, 'Null deref'), file: '\x1b]52;c;ZXZpbA==\x07src/\x1b[2Ja.ts' }],
        },
      }),
    );
    const ctx = ctxFor(dir);
    const list = render(initialState(), ctx);
    expect(list).toContain('codex: timed out red');
    expect(list).not.toContain('\x1b');
    const detail = render(press(ctx, ['enter']), ctx);
    expect(detail).toContain('Null deref  src/a.ts:3');
    expect(detail).not.toContain('\x1b');
  });

  test('without 24-bit color, the palette falls back to the basic colors and paints no backgrounds', () => {
    const ctx = ctxFor();
    const st = themeStyles(true, 'basic');
    const text = renderTui(initialState(), ctx, st, '0.6.0').join('\n');
    expect(text).not.toContain('48;2;');
    expect(text).not.toContain('38;2;');
    expect(text).toContain('\x1b[36m');
    // The selected row shows as reverse video.
    expect(text).toContain('\x1b[7m');
    expect(renderTui(initialState(), ctx, themeStyles(false, 'basic'), '0.6.0').join('')).not.toContain('\x1b');
    expect(colorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorDepth({ COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorDepth({ TERM: 'xterm-direct' })).toBe('truecolor');
    expect(colorDepth({ TERM_PROGRAM: 'vscode' })).toBe('truecolor');
    expect(colorDepth({ WT_SESSION: 'abc' })).toBe('truecolor');
    expect(colorDepth({ FORCE_COLOR: '3' })).toBe('truecolor');
    expect(colorDepth({ TERM: 'xterm-256color' })).toBe('basic');
    expect(colorDepth({})).toBe('basic');
  });

  test('asks for a bigger terminal under the minimum size', () => {
    const ctx = ctxFor(undefined, { height: 8, width: 80 });
    const frame = lines(initialState(), ctx);
    expect(frame).toHaveLength(8);
    expect(frame.join('\n')).toContain('REVIEW-RELAY');
    expect(frame.join('\n')).toContain(`Resize to at least ${MIN_SIZE.width} × ${MIN_SIZE.height}.`);
    expect(frame.join('\n')).toContain('Press q to exit.');
    expect(frame.join('\n')).not.toContain('acme/app');
    expect(lines(initialState(), ctxFor(undefined, { height: 30, width: 39 })).join('\n')).toContain('Resize');
    expect(lines(initialState(), ctxFor(undefined, { height: 10, width: 40 })).join('\n')).toContain('STATUS');
    expect(press(ctx, ['q']).done).toBe(true);
  });

  test('says so when the daemon is stopped and when there are no jobs', () => {
    const dir = tempDir('relay-none-');
    const ctx = ctxFor(dir, { daemon: { ...DAEMON, running: false, pid: null } });
    const text = render(initialState(), ctx);
    expect(text).toContain('✗ daemon stopped  start it with review-relay start -d  │  no review jobs yet');
    expect(text).toContain('Jobs appear here as the daemon reviews PRs');
    expect(text).not.toContain('Job ·');
    expect(text).toContain(' [↑↓] move   [/] filter   [s] status   [?] help   [q] quit');
    expect(render(initialState(), ctxFor(dir, { daemon: null }))).toContain('daemon …');
  });
});

describe('themes', () => {
  test('cycles themes in each main view without losing navigation or consuming filter text', () => {
    const ctx = ctxFor();
    for (const view of ['list', 'detail', 'log'] as const) {
      let state: TuiState = { ...initialState(), view, selected: DONE.key, scroll: 2 };
      for (const theme of ['light', 'terminal', 'dark'] as const) {
        state = reduce(state, 't', ctx);
        expect(state).toMatchObject({ theme, view, selected: DONE.key, scroll: 2, effect: { kind: 'theme', theme } });
        expect(render(state, ctx)).toContain(`[t] ${theme}`);
      }
    }
    expect(press(ctx, ['/', 't'])).toMatchObject({ theme: 'dark', filter: 't', effect: undefined });
    expect(press(ctx, ['down', 'r', 't'])).toMatchObject({ theme: 'dark', confirm: undefined, effect: undefined });
  });

  test('saves the preference, preserves current config fields, and restores it on reopening', () => {
    const path = join(tempDir('relay-theme-'), 'config.json');
    const raw = { repos: [{ fullName: 'acme/app', localPath: '/tmp/app' }], port: 9988 };
    const config = parseConfig(raw);
    const current = { ...raw, port: 9999, custom: { keep: true } };
    writeFileSync(path, JSON.stringify(current));
    expect(perform({ kind: 'theme', theme: 'terminal' }, config, path).tone).toBe('success');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved).toEqual({ ...current, theme: 'terminal' });
    expect(initialState(parseConfig(saved).theme).theme).toBe('terminal');
    writeFileSync(path, 'invalid JSON');
    expect(() => perform({ kind: 'theme', theme: 'light' }, config, path)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('invalid JSON');
  });

  test('light paints readable colors throughout; terminal inherits defaults without any RGB overrides', () => {
    const ctx = ctxFor();
    const light = renderTui(initialState('light'), ctx, themeStyles(true, 'truecolor', 'light'), 'test').join('\n');
    expect(light).toContain('\x1b[48;2;243;246;250;38;2;24;43;58m');
    expect(light).toContain('\x1b[38;2;136;85;0mrunning');
    expect(light).toContain('\x1b[38;2;179;38;50mfailed');
    const terminal = renderTui(initialState('terminal'), ctx, themeStyles(true, 'truecolor', 'terminal'), 'test').join(
      '\n',
    );
    expect(terminal).not.toMatch(/(?:38|48);(?:2|5);/);
    expect(terminal).toContain('\x1b[39;49m');
    expect(terminal).toContain('\x1b[39;49;7m');
    for (const theme of THEMES) {
      for (const depth of ['truecolor', 'basic'] as const) {
        for (const color of [true, false]) {
          for (const view of ['list', 'detail', 'log', 'help'] as const) {
            const rendered = renderTui({ ...initialState(theme), view }, ctx, themeStyles(color, depth, theme), 'test');
            expect(rendered).toHaveLength(ctx.height);
            expect(rendered.every((line) => visibleLength(line) === ctx.width)).toBe(true);
            if (!color) expect(rendered.join('')).not.toContain('\x1b');
          }
        }
      }
    }
  });
});

describe('list view', () => {
  test('moves with the arrows, wraps, and jumps with g/G and the page keys', () => {
    const ctx = ctxFor();
    const at = (list: TuiState) => visible(list, ctx.store.jobs).findIndex((j) => j.key === list.selected);
    expect(press(ctx, ['down']).selected).toBe(DONE.key);
    expect(at(press(ctx, ['down', 'down', 'j', 'j']))).toBe(0);
    expect(at(press(ctx, ['up']))).toBe(3);
    expect(at(press(ctx, ['G']))).toBe(3);
    expect(at(press(ctx, ['G', 'g']))).toBe(0);
    expect(at(press(ctx, ['pagedown']))).toBe(3);
    expect(at(press(ctx, ['pagedown', 'pageup']))).toBe(0);
    const text = render(press(ctx, ['down']), ctx);
    expect(text).toMatch(/▌ done/);
    expect(text).toContain('2 of 4');
    expect(text).toContain('Job · acme/app #7 ');
    expect(text).toContain('│ acme/app #7  bbbbbbbb  ✓ done');
  });

  test('the cursor follows its job when newer jobs appear above it', () => {
    const dir = dataDir([DONE, FAILED]);
    const ctx = ctxFor(dir);
    const onFailed = press(ctx, ['down']);
    expect(onFailed.selected).toBe(FAILED.key);
    writeFileSync(join(dir, 'state.json'), JSON.stringify([RUNNING, DONE, FAILED]));
    ctx.store.refresh();
    expect(render(onFailed, ctx)).toMatch(/▌ failed/);
    // A selected job that vanished puts the cursor back on top.
    writeFileSync(join(dir, 'state.json'), JSON.stringify([RUNNING, DONE]));
    ctx.store.refresh();
    expect(render(onFailed, ctx)).toMatch(/▌ running/);
  });

  test('scrolls the table around the cursor when the jobs outgrow the panel, dropping the detail pane first', () => {
    const ctx = ctxFor(dataDir(MANY), { height: 14 });
    const frame = lines(press(ctx, ['G']), ctx);
    expect(frame).toHaveLength(14);
    const text = frame.join('\n');
    expect(text).toMatch(/↑ \d+ more/);
    expect(text).toMatch(/▌ done\s+.*#111/);
    expect(text).toContain('12 of 12');
    expect(text).not.toContain('Job ·');
    // With room, the pane comes back and the table keeps the cursor in view.
    const tall = render(press(ctx, ['G']), { ...ctx, height: 40 });
    expect(tall).toContain('Job · acme/app #111');
    expect(tall).not.toMatch(/more/);
  });

  test('/ filters by any column text, s cycles the status filter, esc clears them before quitting', () => {
    const ctx = ctxFor();
    const typing = press(ctx, ['/', ...'lib']);
    expect(typing.filtering).toBe(true);
    expect(typing.filter).toBe('lib');
    const text = render(typing, ctx);
    expect(text).toContain('showing 1  / lib▏');
    expect(text).toContain(' [type] to filter   [↑↓] move   [enter] keep filter   [esc] clear it');
    expect(text).not.toContain('acme/app');
    expect(press(ctx, [...'q'], typing).done).toBeUndefined();
    const kept = press(ctx, ['enter'], typing);
    expect(kept.filtering).toBe(false);
    expect(render(kept, ctx)).toContain('showing 1  / lib');
    expect(render(kept, ctx)).toContain('[esc] clear filter');
    expect(press(ctx, ['escape'], kept).filter).toBeUndefined();
    expect(press(ctx, ['escape'], typing).filter).toBeUndefined();
    expect(visible(press(ctx, ['/', ...'risky', 'enter']), ctx.store.jobs)).toEqual([FAILED]);
    expect(visible(press(ctx, ['/', ...'timed', 'space', ...'out', 'enter']), ctx.store.jobs)).toEqual([FAILED]);
    expect(render(press(ctx, ['/', ...'zzz']), ctx)).toContain('no job matches the filter');

    const cycle = ['queued', 'running', 'done', 'failed', 'skipped', 'superseded', undefined];
    let state = initialState();
    for (const status of cycle) {
      state = reduce(state, 's', ctx);
      expect(state.status).toBe(status as TuiState['status']);
    }
    const done = press(ctx, ['s', 's', 's']);
    expect(render(done, ctx)).toContain('[done]');
    expect(visible(done, ctx.store.jobs)).toEqual([DONE]);
    expect(press(ctx, ['escape'], done).status).toBeUndefined();
    expect(press(ctx, ['escape']).done).toBe(true);
    expect(press(ctx, ['q']).done).toBe(true);
    expect(press(ctx, ['ctrl-c'], typing).done).toBe(true);
  });

  test('? opens the key help; scroll keys scroll it and any other key closes it', () => {
    const ctx = ctxFor();
    const help = press(ctx, ['?']);
    expect(help.view).toBe('help');
    const text = render(help, ctx);
    expect(text).toMatch(/╭─ Keys ─+ \[any other key] close ─╮/);
    expect(text).toContain('review the PR or local branch again (asks first)');
    expect(text).toContain(' [↑↓] scroll   [any other key] closes help');
    expect(press(ctx, ['down'], help).view).toBe('help');
    expect(press(ctx, ['x'], help).view).toBe('list');
    expect(press(ctx, ['left'], help).view).toBe('list');

    // On a short, narrow terminal the descriptions wrap and the panel scrolls instead of cutting the rest off.
    const small = { ...ctx, height: 14, width: 60 };
    const top = render(help, small);
    expect(top).toMatch(/╭─ Keys ─+ 1-8 of \d+ {2}\[any other key] close ─╮/);
    expect(top).toContain('│ enter        open the job: scores, findings, and the     │');
    expect(top).toContain('│              posted comment');
    expect(top).not.toContain('quit');
    const end = press(small, ['G'], help);
    expect(end.view).toBe('help');
    expect(render(end, small)).toContain('│ q            quit');
    expect(render(press(small, ['j', 'k'], help), small)).toBe(top);
    // Help starts at its top whatever the view before it had scrolled to.
    const scrolledFirst = press(small, ['down', 'enter', 'G', 'escape', '?']);
    expect(scrolledFirst.scroll).toBe(0);
    expect(render(scrolledFirst, small)).toContain('1-8 of');
    expect(render(press(small, ['down', 'enter', 'G', '?']), small)).toContain('1-8 of');
    expect(render(press(small, ['L', 'up', '?']), small)).toContain('1-8 of');
  });
});

describe('detail view', () => {
  test('selects the next header at the scroll position, or the last section past all headers', () => {
    const dir = dataDir();
    writeFileSync(
      join(reportDirFor(dir, DONE), 'comment.md'),
      [
        '<details><summary>First</summary>',
        'First body.',
        '</details>',
        '<details><summary>Middle</summary>',
        'Middle body.',
        '</details>',
        '<details><summary>Last</summary>',
        ...Array.from({ length: 20 }, (_, i) => `- Last body ${i}`),
        '</details>',
      ].join('\n'),
    );
    const ctx = ctxFor(dir, { height: 14 });
    const detail = press(ctx, ['down', 'enter']);
    let middle = detail;
    for (let i = 0; i < 100 && !lines(middle, ctx)[3]!.includes('▾ Middle'); i++) {
      middle = press(ctx, ['down'], middle);
    }
    expect(lines(middle, ctx)[3]).toContain('▾ Middle');
    const bottom = press(ctx, ['G'], detail);
    expect(render(bottom, ctx)).not.toContain('▾');
    for (const key of [']', 'enter', 'space']) {
      for (const [state, expected] of [
        [detail, 0],
        [middle, 3],
        [press(ctx, ['down'], middle), 6],
        [bottom, 6],
      ] as const) {
        const next = press(ctx, [key], state);
        expect(next.details?.selected).toBe(expected);
        expect(next.details?.collapsed).toEqual(key === ']' ? [] : [expected]);
      }
    }
  });

  test('selects and toggles individual comment details without hiding adjacent content', () => {
    const dir = dataDir();
    writeFileSync(
      join(reportDirFor(dir, DONE), 'comment.md'),
      [
        '- **Minor** First finding',
        '  <details><summary>Details</summary>',
        '',
        '  First explanation.',
        '',
        '  **Suggested fix:** First fix.',
        '',
        '  </details>',
        '- **Major** Second finding',
        '  <details><summary>Details</summary>',
        '',
        '  Second explanation.',
        '',
        '  </details>',
        '<details><summary>Dimension notes</summary>',
        '',
        'Dimension explanation.',
        '',
        '</details>',
        'After all details.',
      ].join('\n'),
    );
    const ctx = ctxFor(dir, { height: 70 });
    const detail = press(ctx, ['down', 'enter']);
    expect(render(detail, ctx)).toContain('▾ Details');
    expect(render(detail, ctx)).toContain('First explanation.');
    const first = press(ctx, [']', 'enter'], detail);
    const collapsed = render(first, ctx);
    expect(collapsed).toContain('▸ Details');
    expect(collapsed).not.toContain('First explanation.');
    expect(collapsed).not.toContain('First fix.');
    expect(collapsed).toContain('Second explanation.');
    expect(collapsed).toContain('Dimension explanation.');
    expect(collapsed).toContain('After all details.');
    const second = press(ctx, [']', 'space'], first);
    expect(render(second, ctx)).not.toContain('Second explanation.');
    const reopened = press(ctx, ['[', 'enter'], second);
    expect(render(reopened, ctx)).toContain('First explanation.');
    expect(render(reopened, ctx)).toContain('First fix.');
    expect(render(reopened, ctx)).not.toContain('Second explanation.');
    expect(render(press(ctx, ['n', 'p'], second), ctx)).toContain('Second explanation.');

    // Selection reveals off-screen summaries; collapse and resize keep the viewport in range.
    const small = { ...ctx, height: 14, width: 65 };
    const selected = press(small, [']'], detail);
    expect(render(selected, small)).toContain('▾ Details');
    expect(render(selected, small)).toContain('[enter] toggle');
    const toggled = press(small, ['enter'], selected);
    expect(render(toggled, small)).toContain('▸ Details');
    expect(render(press(small, ['enter'], toggled), small)).toContain('First explanation.');
    expect(render(press(ctx, ['G', 'enter'], selected), ctx)).toContain('▸ Details');
  });

  test('shows the job, its reviewers, the merged findings, and the comment; n/p walk the list', () => {
    const ctx = ctxFor();
    const detail = press(ctx, ['down', 'enter']);
    expect(detail.view).toBe('detail');
    const text = render(detail, ctx);
    expect(text).toMatch(/╭─ Job · acme\/app #7 ─+ \[n\/p] next\/prev {3}\[esc] back ─╮/);
    expect(text).toContain('│ acme/app #7  bbbbbbbb  ✓ done');
    expect(text).toContain('url       https://github.com/acme/app/pull/7');
    expect(text).toMatch(/started {3}2026-10-02 \d\d:00:00 {2}2m05s/);
    expect(text).toContain('base      main');
    expect(text).toContain('score     3/5');
    expect(text).toContain('codex   4/5  1m05s · gpt-6-astra, effort high');
    expect(text).toContain('claude  3/5  1m30s · claude-opus-5-5');
    expect(text).toContain('Findings (2)');
    expect(text).toContain('major    Null deref  src/a.ts:3');
    expect(text).toContain('by codex, claude');
    expect(text).toContain('minor    Typo  src/a.ts:40');
    expect(text).toContain('Comment');
    // The comment's markdown is rendered: the heading loses its hashes.
    expect(text).toContain('│   review-relay: 3/5');
    expect(text).not.toContain('## review-relay');
    expect(text).toContain(
      ' [[/]] details   [enter] toggle   [↑↓] scroll   [n/p] next/prev   [l] log   [r] re-run   [o] open PR   [y] copy url   [esc] back',
    );

    const failed = press(ctx, ['n'], detail);
    expect(failed.selected).toBe(FAILED.key);
    const failedText = render(failed, ctx);
    expect(failedText).toContain('│ acme/lib #12  cccccccc  ✗ failed');
    expect(failedText).toContain('source    github · route risky');
    expect(failedText).toContain('error     codex: timed out after 1800s');
    expect(failedText).toContain('Log');
    expect(failedText).toContain('09:30:00 [acme/lib] PR #12: failed');
    expect(press(ctx, ['p', 'p'], failed).selected).toBe(RUNNING.key);
    expect(press(ctx, ['p', 'p', 'p'], failed).selected).toBe(RUNNING.key);
    expect(press(ctx, ['escape'], failed).view).toBe('list');
    expect(press(ctx, ['left'], failed).view).toBe('list');
  });

  test('shows what each reviewer cost in the list, the detail, and the status bar', () => {
    const dir = dataDir();
    const report = reportDirFor(dir, DONE);
    const meta = JSON.parse(readFileSync(join(report, 'meta.json'), 'utf8'));
    const usage = { inputTokens: 288_000, cachedInputTokens: 200_000, cacheWriteTokens: 0, outputTokens: 9_000 };
    meta.reviewers[0].usage = { ...usage, costUsd: 0.62, costSource: 'estimated' };
    meta.reviewers[1].usage = { ...usage, inputTokens: 412_000, outputTokens: 12_000, costUsd: 1.84 };
    writeFileSync(join(report, 'meta.json'), JSON.stringify(meta));
    const ctx = ctxFor(dir);

    const list = render(initialState(), ctx);
    expect(list).toContain('~$2.46 spent');
    expect(list).toMatch(/CLAUDE\s+COST\s+CRIT/);
    expect(list).toMatch(/3\/5 1m30s\s+~\$2\.46/);

    const text = render(press(ctx, ['down', 'enter']), ctx);
    expect(text).toContain('cost      ~$2.46  codex ~$0.62 · claude $1.84');
    expect(text).toContain('codex   4/5  1m05s · gpt-6-astra, effort high · ~$0.62 · 288k in/9k out');
    expect(text).toContain('claude  3/5  1m30s · claude-opus-5-5 · $1.84 · 412k in/12k out');

    // A finished review whose report has no cost makes the total a lower bound, as `cost` marks it.
    const failedReport = reportDirFor(dir, FAILED);
    mkdirSync(failedReport, { recursive: true });
    writeFileSync(
      join(failedReport, 'meta.json'),
      JSON.stringify({ reviewers: [{ name: 'codex', ok: false, durationMs: 1 }] }),
    );
    expect(render(initialState(), ctxFor(dir))).toContain('~$2.46+ spent');

    // Reports from before costs were recorded show none of it.
    const plain = ctxFor();
    expect(render(initialState(), plain)).not.toContain('spent');
    expect(render(initialState(), plain)).not.toContain('COST');
    expect(render(press(plain, ['down', 'enter']), plain)).not.toContain('cost  ');
  });

  test('a running job shows its elapsed time and log so far; a skipped one says why it is empty', () => {
    const ctx = ctxFor();
    const text = render(press(ctx, ['enter']), ctx);
    expect(text).toContain('│ acme/app #7  aaaaaaaa  ! running');
    expect(text).toContain('3m30s so far');
    expect(text).toContain('11:00:00 [acme/app] PR #7 @ aaaaaaaa: reviewing (opened)');
    expect(render(press(ctx, ['G', 'enter']), ctx)).toContain('a skip route matched, so no reviewer ran');
  });

  test('scrolls with the arrows and page keys, clamped to the content, with the range in the border', () => {
    const ctx = ctxFor(undefined, { height: 14 });
    const detail = press(ctx, ['down', 'enter']);
    const top = render(detail, ctx);
    expect(top).toContain('│ acme/app #7  bbbbbbbb');
    expect(top).toContain(' 1-8 of 23 ');
    expect(top).not.toContain('## review-relay');
    const down = press(ctx, ['down', 'down', 'down'], detail);
    expect(down.scroll).toBe(3);
    expect(render(down, ctx)).not.toContain('│ acme/app #7  bbbbbbbb');
    expect(render(down, ctx)).toContain(' 4-11 of 23 ');
    const bottom = press(ctx, ['G'], detail);
    expect(render(bottom, ctx)).toContain('Looks ok.');
    expect(render(bottom, ctx)).toContain(' 16-23 of 23 ');
    expect(press(ctx, ['down'], bottom).scroll).toBe(bottom.scroll);
    expect(press(ctx, ['pageup', 'pageup', 'pageup'], bottom).scroll).toBe(0);
    expect(press(ctx, ['up'], detail).scroll).toBe(0);
  });
});

describe('log view', () => {
  test('l shows the selected job’s log lines following the end; L switches to the whole log', () => {
    const ctx = ctxFor(undefined, { height: 14 });
    const log = press(ctx, ['down', 'down', 'l']);
    expect(log.view).toBe('log');
    const text = render(log, ctx);
    expect(text).toMatch(/╭─ Log · acme\/lib #12 ─+ following {2}\[L] whole log ─╮/);
    expect(text).toContain('09:30:00 [acme/lib] PR #12: failed');
    expect(text).not.toContain('server listening');
    expect(text).toContain(' [↑↓] scroll   [G] follow   [L] whole log   [esc] back');
    const whole = press(ctx, ['L'], log);
    const wholeText = render(whole, ctx);
    expect(wholeText).toContain('Log · /tmp/relay-tui-');
    expect(wholeText).toContain('daemon.log');
    expect(wholeText).toContain('server listening');
    expect(wholeText).toContain('lines 5-12 of 12 · following  [L] this job only');
    // Scrolling up stops following; G resumes it.
    const up = press(ctx, ['up'], whole);
    expect(up.follow).toBe(false);
    expect(render(up, ctx)).toContain('lines 4-11 of 12  [L]');
    expect(press(ctx, ['up', 'up', 'up', 'up'], up).scroll).toBe(0);
    expect(press(ctx, ['G'], up).follow).toBe(true);
    expect(press(ctx, ['escape'], up).view).toBe('list');
    expect(render(press(ctx, ['G', 'l']), ctx)).toContain('nothing logged for this job yet');
    // The Log tab lights up.
    expect(lines(whole, ctx)[0]).toContain('1 Jobs   2 Log');
  });

  test('2 and tab open the Log tab, 1 and tab return to Jobs, from any view', () => {
    const ctx = ctxFor();
    expect(press(ctx, ['2']).view).toBe('log');
    expect(press(ctx, ['tab']).view).toBe('log');
    expect(press(ctx, ['tab', 'tab']).view).toBe('list');
    expect(press(ctx, ['2', '1']).view).toBe('list');
    expect(press(ctx, ['2', '2']).view).toBe('log');
    expect(press(ctx, ['down', 'enter', '2']).view).toBe('log');
    // The log opens on the highlighted job and follows its end; a kept whole-log choice stays.
    const log = press(ctx, ['down', 'down', 'tab']);
    expect(log.follow).toBe(true);
    expect(render(log, ctx)).toContain('Log · acme/lib #12');
    expect(press(ctx, ['L', '1', '2'], log).wholeLog).toBe(true);
    // While typing a filter, digits are text.
    expect(press(ctx, ['/', '2']).filter).toBe('2');
    expect(parseKeys('\t')).toEqual(['tab']);
  });
});

describe('actions', () => {
  test('r asks before re-running, y confirms with an effect, anything else cancels; running jobs refuse', () => {
    const ctx = ctxFor();
    const asked = press(ctx, ['down', 'r']);
    expect(asked.confirm).toEqual({ action: 'rerun', key: DONE.key });
    const text = render(asked, ctx);
    expect(text).toContain(' ! review acme/app #7 again with the configured reviewers?');
    expect(text).toContain(' [y] re-run   [any other key] cancel');
    const go = press(ctx, ['y'], asked);
    expect(go.confirm).toBeUndefined();
    expect(go.effect).toEqual({ kind: 'rerun', job: DONE });
    // The effect is consumed by the next key.
    expect(press(ctx, ['down'], go).effect).toBeUndefined();
    const no = press(ctx, ['n'], asked);
    expect(no.effect).toBeUndefined();
    expect(no.view).toBe('list');
    expect(render(no, ctx)).toContain(' ○ cancelled');
    const busy = press(ctx, ['r']);
    expect(busy.confirm).toBeUndefined();
    expect(render(busy, ctx)).toContain(' ! acme/app #7 is being reviewed now');
    // The flash expires.
    expect(render(busy, { ...ctx, now: NOW + 5000 })).not.toContain('is being reviewed now');
    // r works from the detail view too.
    expect(press(ctx, ['down', 'enter', 'r', 'y']).effect).toEqual({ kind: 'rerun', job: DONE });
  });

  test('acting on the top job pins it, and the confirmation stays bound to the job it asked about', () => {
    const dir = dataDir([DONE, FAILED]);
    const ctx = ctxFor(dir);
    expect(initialState().selected).toBeUndefined();
    expect(press(ctx, ['enter']).selected).toBe(DONE.key);
    expect(press(ctx, ['l']).selected).toBe(DONE.key);
    expect(press(ctx, ['2']).selected).toBe(DONE.key);
    expect(press(ctx, ['o']).selected).toBe(DONE.key);
    const asked = press(ctx, ['r']);
    expect(asked.selected).toBe(DONE.key);
    expect(render(asked, ctx)).toContain('review acme/app #7 again');
    // A newer job lands on top while the question is open: the answer still applies to acme/app #7.
    writeFileSync(join(dir, 'state.json'), JSON.stringify([RUNNING, DONE, FAILED]));
    ctx.store.refresh();
    expect(render(asked, ctx)).toContain('review acme/app #7 again');
    expect(press(ctx, ['y'], asked).effect).toEqual({ kind: 'rerun', job: DONE });
    // The asked-about job started running meanwhile: no duplicate review.
    const started = { ...DONE, status: 'running' as const, finishedAt: undefined };
    writeFileSync(join(dir, 'state.json'), JSON.stringify([started, FAILED]));
    ctx.store.refresh();
    const busy = press(ctx, ['y'], asked);
    expect(busy.effect).toBeUndefined();
    expect(render(busy, ctx)).toContain('acme/app #7 is being reviewed now');
    // Or it vanished.
    writeFileSync(join(dir, 'state.json'), JSON.stringify([FAILED]));
    ctx.store.refresh();
    const gone = press(ctx, ['y'], asked);
    expect(gone.effect).toBeUndefined();
    expect(render(gone, ctx)).toContain('that job is no longer listed');
  });

  test('o and y hand the PR url to the loop', () => {
    const ctx = ctxFor();
    expect(prUrl(FAILED)).toBe('https://github.com/acme/lib/pull/12');
    expect(press(ctx, ['o']).effect).toEqual({ kind: 'open', url: 'https://github.com/acme/app/pull/7' });
    expect(press(ctx, ['down', 'down', 'enter', 'y']).effect).toEqual({ kind: 'copy', text: prUrl(FAILED) });
    expect(press(ctx, ['o'], initialState()).view).toBe('list');
    expect(press(ctxFor(tempDir('relay-none-')), ['o']).effect).toBeUndefined();
  });
});

describe('term helpers', () => {
  test('clip cuts to the visible width and closes open styling', () => {
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip('\x1b[32mabc\x1b[0mdef', 4)).toBe('\x1b[32mabc\x1b[0md');
    expect(clip('\x1b[32mabcdef\x1b[0m', 2)).toBe('\x1b[32mab\x1b[0m');
    expect(clip('ab', 5)).toBe('ab');
    expect(clip('→→→→', 2)).toBe('→→');
    expect(clip('abc', 0)).toBe('');
  });

  test('visible length counts columns, so a row with emoji is padded to the full width', () => {
    expect(visibleLength('🚀🚀')).toBe(2);
    expect(visibleLength('\x1b[32m🚀\x1b[0mab')).toBe(3);
    expect(fill('🚀', 3)).toBe('🚀  ');
    const rocket = job('ffffffff5', { source: 'local', pr: 0, branch: 'feat/🚀-launch', base: 'main' });
    const ctx = ctxFor(dataDir([rocket, DONE]), { width: 70 });
    for (const view of ['list', 'detail', 'log'] as const) {
      const frame = renderTui({ ...initialState(), view }, ctx, themeStyles(false), 'x');
      for (const line of frame) expect(visibleLength(line)).toBe(70);
    }
    expect(render(initialState(), ctx)).toContain('feat/🚀-launch');
  });

  test('clip from a column and pan keep the styling opened before the cut', () => {
    expect(clip('abcdef', 3, 2)).toBe('cde');
    expect(clip('\x1b[32mabc\x1b[0mdef', 2, 2)).toBe('\x1b[32mc\x1b[0md');
    expect(clip('abc', 5, 5)).toBe('');
    expect(pan('abcdef', 4)).toBe('ef');
    expect(pan('\x1b[1mab\x1b[0mcd', 3)).toBe('\x1b[1m\x1b[0md');
    expect(pan('abc', 0)).toBe('abc');
    expect(fill('abcdef', 3, undefined, 4)).toBe('ef ');
  });

  test('fill pads to the width and, with a base, paints it and restores it after every reset', () => {
    expect(fill('ab', 4)).toBe('ab  ');
    expect(fill('abcdef', 4)).toBe('abcd');
    expect(fill('\x1b[31mx\x1b[0my', 4, '48;2;1;2;3')).toBe(
      '\x1b[48;2;1;2;3m\x1b[31mx\x1b[0m\x1b[48;2;1;2;3my  \x1b[0m',
    );
    expect(rgb(0x0d1421)).toBe('38;2;13;20;33');
    expect(rgb(0xffffff, 'bg')).toBe('48;2;255;255;255');
  });

  test('frame positions every row, erases only after short rows, and clears below a short frame', () => {
    expect(frame(['ab', 'c'], 3, 2)).toBe('\x1b[1;1Hab\x1b[2;1Hc\x1b[K\x1b[3;1H\x1b[J');
    // A full frame of full-width rows writes no erase at all, so the last column stays painted.
    expect(frame(['ab', 'cd'], 2, 2)).toBe('\x1b[1;1Hab\x1b[2;1Hcd');
    expect(frame(['abcd'], 1, 2)).toBe('\x1b[1;1Hab');
    expect(frame(['a', 'b', 'c'], 2, 3)).toBe('\x1b[1;1Ha\x1b[K\x1b[2;1Hb\x1b[K');
  });

  test('moved wraps on the arrows and clamps on home, end, and the page keys', () => {
    expect(moved(0, 'up', 5)).toBe(4);
    expect(moved(4, 'down', 5)).toBe(0);
    expect(moved(2, 'k', 5)).toBe(1);
    expect(moved(2, 'j', 5)).toBe(3);
    expect(moved(3, 'home', 5)).toBe(0);
    expect(moved(1, 'G', 5)).toBe(4);
    expect(moved(1, 'pagedown', 5, 10)).toBe(4);
    expect(moved(4, 'pageup', 5, 2)).toBe(2);
    expect(moved(1, 'x', 5)).toBeUndefined();
    expect(moved(0, 'down', 0)).toBeUndefined();
  });

  test('parseKeys names the paging keys in both escape forms', () => {
    expect(parseKeys('\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH')).toEqual([
      'pageup',
      'pagedown',
      'home',
      'end',
      'home',
      'end',
      'home',
    ]);
  });
});

describe('local reviews', () => {
  const LOCAL = job('ffffffff5', {
    key: 'acme/app@ffffffff5:local',
    pr: 0,
    source: 'local',
    branch: 'feat/login',
    base: 'origin/main',
    localPath: '/work/app',
    startedAt: '2026-10-02T11:01:00.000Z',
    finishedAt: '2026-10-02T11:03:05.000Z',
  });

  test('list and detail name the branch, base, and checkout instead of a PR', () => {
    const dir = dataDir([LOCAL, DONE]);
    writeFileSync(
      join(dir, 'daemon.log'),
      [
        '11:01:00 [acme/app] branch feat/login @ ffffffff: reviewing (local review of feat/login against origin/main)',
        '11:01:01 [acme/app] PR #7 @ bbbbbbbb: reviewing (opened)',
        '11:04:00 [acme/app] branch feat/login @ ffffffff: done -> /tmp/x',
      ].join('\n') + '\n',
    );
    const ctx = ctxFor(dir);
    const list = render(initialState(), ctx);
    expect(list).toMatch(/done +- +10-02 \d\d:\d\d +2m05s +acme\/app +feat\/login +ffffffff +local/);
    expect(list).toContain('Job · acme/app feat/login');
    const detail = render(press(ctx, ['enter']), ctx);
    expect(detail).toContain('branch    feat/login against origin/main');
    expect(detail).toContain('checkout  /work/app');
    expect(detail).not.toContain('https://github.com');
    expect(ctx.store.log(LOCAL)).toEqual([
      '11:01:00 [acme/app] branch feat/login @ ffffffff: reviewing (local review of feat/login against origin/main)',
      '11:04:00 [acme/app] branch feat/login @ ffffffff: done -> /tmp/x',
    ]);
  });

  test('o and y say there is no PR yet; r asks, then re-runs the branch', () => {
    const ctx = ctxFor(dataDir([LOCAL]));
    expect(press(ctx, ['o']).flash?.text).toContain('a local review has no PR');
    expect(press(ctx, ['y']).effect).toBeUndefined();
    const asked = press(ctx, ['r']);
    expect(render(asked, ctx)).toContain('review acme/app feat/login again with the configured reviewers?');
    expect(press(ctx, ['y'], asked).effect).toEqual({ kind: 'rerun', job: LOCAL });
  });

  test('a job whose process is gone shows as failed; one without a pid stays running', () => {
    const gone = Bun.spawnSync(['true']).pid;
    const dir = dataDir([{ ...LOCAL, status: 'running', finishedAt: undefined, pid: gone }, RUNNING]);
    expect(readJobs(join(dir, 'state.json')).map((j) => [j.status, j.error])).toEqual([
      ['failed', 'stopped before finishing'],
      ['running', undefined],
    ]);
  });
});

describe('small terminals', () => {
  test('the header, status line, and footer give way gracefully instead of being cut mid-word', () => {
    const wide = ctxFor();
    const narrow = { ...wide, width: 80 };
    const rows = lines(initialState(), narrow);
    for (const line of rows) expect(visibleLength(line)).toBe(80);
    expect(rows[0]).toContain('/tmp/');
    const header = lines(initialState(), { ...wide, width: 60 })[0];
    expect(header).toMatch(/^ ◆ REVIEW-RELAY {3}1 Jobs {3}2 Log {3}\[t] dark\s+$/);
    expect(header).not.toContain('/tmp/');
    // The daemon's details go first; the counts stay while they fit.
    expect(rows[1]).toBe(' ✓ daemon running  │  4 jobs · 1 running · 1 done · 1 failed · 1 skipped'.padEnd(80));
    expect(rows.at(-1)).toBe(
      ' [↑↓] move   [←→] sideways   [enter] open   [l] log   [r] re-run   …   [?] help'.padEnd(80),
    );
    expect(render(initialState(), { ...wide, width: 50 })).toContain(' ✓ daemon running  │  4 jobs ');

    const tiny = lines(initialState(), { ...wide, width: 40, height: 10 });
    expect(tiny).toHaveLength(10);
    for (const line of tiny) expect(visibleLength(line)).toBe(40);
    expect(tiny[0]).toBe(' ◆ REVIEW-RELAY   1 Jobs   2 Log'.padEnd(40));
    expect(tiny[1]).toBe(' ✓ daemon running  │  4 jobs'.padEnd(40));
    expect(tiny[2]).toMatch(/^╭─ Jobs ─+ 1 of 4 · \d+ more → ─╮$/);
    expect(tiny.at(-1)).toBe(' [↑↓] move   …   [?] help'.padEnd(40));
    // A long title gives way to the panel's corners.
    const stopped = { ...wide, width: 40, daemon: { ...DAEMON, running: false, pid: null } };
    expect(render(press(stopped, ['L']), stopped)).toMatch(/^╭─ Log · \/tmp\/relay-tui-.*… ─+╮$/m);
    expect(render(initialState(), stopped)).toContain(' ✗ daemon stopped  │  4 jobs');

    // The filter being typed is never the part that goes.
    const typing = render(press({ ...wide, width: 44 }, ['/', 'l', 'i', 'b']), { ...wide, width: 44 });
    expect(typing).toContain(' ✓ daemon running  showing 1  / lib▏');
    expect(typing).toContain(' [type] to filter   …   [esc] clear it');
  });

  test('every view fills a tiny terminal exactly, in every theme', () => {
    const ctx = ctxFor(undefined, { height: 10, width: 40 });
    for (const theme of THEMES) {
      for (const color of [true, false]) {
        for (const view of ['list', 'detail', 'log', 'help'] as const) {
          const rendered = renderTui(
            { ...initialState(theme), view },
            ctx,
            themeStyles(color, 'truecolor', theme),
            'x',
          );
          expect(rendered).toHaveLength(10);
          expect(rendered.every((line) => visibleLength(line) === 40)).toBe(true);
        }
      }
    }
    // Empty and filtered-out lists wrap their hint instead of losing its end.
    const empty = render(initialState(), ctxFor(tempDir('relay-none-'), { height: 12, width: 48 }));
    expect(empty).toContain('│ Jobs appear here as the daemon reviews PRs,  │');
    expect(empty).toContain('review -d');
  });

  test('← → pan a table that is wider than the panel and keep their other meanings at the edges', () => {
    const ctx = ctxFor(undefined, { width: 80 });
    const start = render(initialState(), ctx);
    expect(start).toMatch(/╭─ Jobs ─+ 1 of 4 · \d+ more →  \[\/] filter {3}\[s] status ─╮/);
    expect(start).not.toContain('SCORE');
    // Nothing to the left yet, so ← does nothing; → pans by half the row width.
    expect(press(ctx, ['left'])).toEqual(reduce(initialState(), 'x', ctx));
    const once = press(ctx, ['right']);
    expect(once.view).toBe('list');
    expect(once.hscroll).toBe(37);
    const panned = render(once, ctx);
    expect(panned).toMatch(/╭─ Jobs ─+ 1 of 4 · ← 37 more · \d+ more →/);
    expect(panned).toContain('SCORE');
    expect(panned).not.toContain('STATUS');
    expect(panned).toMatch(/^│ ▌ /m);
    // Past the last column → opens the job, as it does on a wide terminal; the detail starts unpanned.
    let state = once;
    while (render(state, ctx).includes('more →')) state = press(ctx, ['right'], state);
    expect(render(state, ctx)).toContain('codex: timed out');
    const opened = press(ctx, ['right'], state);
    expect(opened.view).toBe('detail');
    expect(opened.hscroll).toBe(0);
    expect(press(ctx, ['left'], once).hscroll).toBe(0);
    // Panning does not move the cursor, and the filter input keeps panning too.
    expect(press(ctx, ['down', 'right']).selected).toBe(DONE.key);
    expect(press(ctx, ['/', 'right']).hscroll).toBe(37);
    expect(render(press(ctx, ['/', 'right']), ctx)).toContain('[←→] sideways');
    // A wide terminal shows everything, so the hint and note are absent and → opens.
    const wide = ctxFor();
    expect(render(initialState(), wide)).not.toContain('sideways');
    expect(render(initialState(), wide)).not.toContain('more →');
    expect(press(wide, ['right']).view).toBe('detail');
  });

  test('the detail and log views pan too; ← at the left edge goes back and → at the right edge moves on', () => {
    const ctx = ctxFor(undefined, { width: 48, height: 24 });
    const detail = press(ctx, ['down', 'enter']);
    const text = render(detail, ctx);
    expect(text).toMatch(/╭─ Job · acme\/app #7 ─+ (?:\d+-\d+ of \d+ · )?\d+ more →/);
    // The sideways hint is one of those that gives way here; the rest stay reachable through the ellipsis.
    expect(text).toContain(' [[/]] details   [enter] toggle   …   [esc] back');
    // Findings wrap to the panel rather than running past it.
    expect(text).toContain('│            why it matters');
    const panned = press(ctx, ['right'], detail);
    expect(panned.view).toBe('detail');
    expect(panned.hscroll).toBeGreaterThan(0);
    expect(render(panned, ctx)).toContain('← ');
    expect(press(ctx, ['left'], panned)).toEqual({ ...panned, hscroll: 0 });
    expect(press(ctx, ['left'], detail).view).toBe('list');
    let end = panned;
    while (render(end, ctx).includes('more →')) end = press(ctx, ['right'], end);
    expect(press(ctx, ['right'], end).selected).toBe(FAILED.key);
    expect(press(ctx, ['n'], end).hscroll).toBe(end.hscroll);

    expect(render(press(ctx, ['L']), ctx)).toContain(' [↑↓] scroll   [←→] sideways   …   [esc] back');
    const log = press(ctx, ['l']);
    expect(render(log, ctx)).toMatch(/╭─ Log · acme\/app #7 ─+ following · \d+ more → ─╮/);
    expect(press(ctx, ['right'], log).hscroll).toBeGreaterThan(0);
    expect(render(press(ctx, ['right'], log), ctx)).toContain('aaaaaaaa: reviewing (opened)');
    expect(render(press(ctx, ['right'], log), ctx)).not.toContain('11:00:00');
    expect(press(ctx, ['left'], log).view).toBe('list');
    expect(press(ctx, ['escape'], press(ctx, ['right'], log)).hscroll).toBe(0);
  });

  test('a resize clamps the pan so a wider terminal never shows a blank panel', () => {
    const narrow = ctxFor(undefined, { width: 60 });
    const state = press(narrow, ['right', 'right', 'right']);
    expect(state.hscroll).toBeGreaterThan(60);
    const wide = { ...narrow, width: 200 };
    const text = render(state, wide);
    expect(text).toContain('STATUS');
    expect(text).not.toContain('more →');
    expect(text).not.toContain('← ');
    // On the wide terminal the arrows have nothing to pan, so they mean what they always did there.
    expect(press(wide, ['left'], state).view).toBe('list');
    expect(press(wide, ['right'], state).view).toBe('detail');
    // Back on the narrow terminal the pan is clamped to what there is to see, never past the last column.
    expect(render({ ...state, hscroll: 10_000 }, narrow)).toContain('codex: timed out');
    expect(render({ ...state, hscroll: 10_000 }, narrow)).not.toContain('more →');
  });

  test('a long message takes rows from the body instead of being cut, and the question has a short form', () => {
    const ctx = ctxFor(undefined, { width: 50, height: 16 });
    const asked = press(ctx, ['down', 'r']);
    const askedText = render(asked, ctx);
    expect(askedText).toContain(' ! review acme/app #7 again?');
    expect(askedText).not.toContain('configured reviewers');
    expect(render(asked, { ...ctx, width: 100 })).toContain(
      ' ! review acme/app #7 again with the configured reviewers?',
    );

    const error = 'theme applied, but not saved: EACCES: permission denied, open /home/me/.review-relay/config.json';
    const flashed = { ...initialState(), flash: { text: error, tone: 'danger' as const, until: NOW + 1 } };
    const frame = lines(flashed, ctx);
    expect(frame).toHaveLength(16);
    for (const line of frame) expect(visibleLength(line)).toBe(50);
    expect(frame.slice(-4, -1)).toEqual([
      ' ✗ theme applied, but not saved: EACCES:'.padEnd(50),
      '   permission denied, open'.padEnd(50),
      '   /home/me/.review-relay/config.json'.padEnd(50),
    ]);
    expect(frame.at(-1)).toContain('[?] help');
    expect(frame.join('\n')).toContain('╰');
    // Past three rows it ends in an ellipsis; a message that fits takes one row, none takes a blank one.
    const long = { ...flashed, flash: { ...flashed.flash, text: Array.from({ length: 40 }, () => 'word').join(' ') } };
    const cut = lines(long, ctx);
    expect(cut).toHaveLength(16);
    expect(cut.at(-2)).toMatch(/^ {3}word (word )*word…\s*$/);
    expect(cut.at(-5)).toMatch(/^╰─+╯$/);
    expect(lines({ ...flashed, flash: { ...flashed.flash, text: 'copied' } }, ctx).at(-3)).toMatch(/^╰─+╯$/);
    expect(lines(initialState(), ctx).at(-2)).toBe(' '.repeat(50));

    // A path wider than the row breaks at the edge rather than losing its end; the third row still ends in an ellipsis.
    const path = '/home/me/code/some/deeply/nested/checkout/path/that/goes/on no longer exists';
    const broken = lines({ ...flashed, flash: { ...flashed.flash, text: path } }, { ...ctx, width: 40 });
    expect(broken.slice(-4, -1)).toEqual([
      ' ✗ /home/me/code/some/deeply/nested/chec'.padEnd(40),
      '   kout/path/that/goes/on'.padEnd(40),
      '   no longer exists'.padEnd(40),
    ]);
    const endless = lines({ ...flashed, flash: { ...flashed.flash, text: 'x'.repeat(200) } }, { ...ctx, width: 40 });
    expect(endless.slice(-4, -1)).toEqual([` ✗ ${'x'.repeat(37)}`, `   ${'x'.repeat(37)}`, `   ${'x'.repeat(36)}…`]);
    expect(endless).toHaveLength(16);
    // Characters outside the BMP take two code units but one column, and must not conjure a blank row.
    const emoji = lines(
      { ...flashed, flash: { ...flashed.flash, text: `${'🚀'.repeat(20)} done` } },
      { ...ctx, width: 40 },
    );
    expect(emoji.slice(-3, -1)).toEqual([` ✗ ${'🚀'.repeat(20)}${' '.repeat(17)}`, '   done'.padEnd(40)]);

    // At the minimum height a three-row message leaves the list two rows: the header and the highlighted job.
    const tiny = lines(flashed, { ...ctx, width: 40, height: 10 });
    expect(tiny).toHaveLength(10);
    expect(tiny[3]).toMatch(/^│ {3}STATUS/);
    expect(tiny[4]).toMatch(/^│ ▌ running/);
    expect(tiny[5]).toMatch(/^╰─+╯$/);
    expect(
      lines(press({ ...ctx, width: 40, height: 10 }, ['G'], flashed), { ...ctx, width: 40, height: 10 })[4],
    ).toMatch(/^│ ▌ skipped/);

    // Paging in a job's detail counts the rows the message took, so a page moves by what is actually visible.
    const two = {
      ...flashed,
      flash: { ...flashed.flash, text: 'a local review has no PR; open one from the branch first' },
    };
    const detail = press(ctx, ['down', 'enter'], two);
    expect(render(detail, ctx).split('\n').slice(-3, -1).join('\n')).toContain('branch first');
    const paged = press(ctx, ['pagedown'], detail);
    const shown = render(paged, ctx).match(/(\d+)-(\d+) of (\d+)/)!;
    const avail = 16 - 5 - 2;
    expect(Number(shown[1])).toBe(avail);
    expect(Number(shown[2]) - Number(shown[1]) + 1).toBe(avail);
  });
});
