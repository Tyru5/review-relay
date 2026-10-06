import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonState } from '../src/daemon.ts';
import { reportDirFor } from '../src/report.ts';
import type { JobRecord } from '../src/state.ts';
import { clip, moved, parseKeys } from '../src/term.ts';
import {
  initialState,
  JobStore,
  prUrl,
  readJobs,
  reduce,
  renderTui,
  visible,
  type TuiContext,
  type TuiState,
} from '../src/tui.ts';
import { styles } from '../src/ui.ts';

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

/** A data folder with the four jobs, a report for the done one, and a daemon log naming two of them. */
function dataDir(jobs: JobRecord[] = [FAILED, DONE, RUNNING, SKIPPED]) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tui-'));
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

const render = (state: TuiState, ctx: TuiContext) => renderTui(state, ctx, styles(false), '0.6.0').join('\n');

describe('readJobs and JobStore', () => {
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

  test('log narrows the daemon log to one job by its repo tag and PR number', () => {
    const store = new JobStore(dataDir());
    expect(store.log(FAILED)).toEqual([
      '09:00:00 [acme/lib] PR #12 @ cccccccc: reviewing (opened)',
      '09:30:00 [acme/lib] PR #12: failed: codex: timed out after 1800s',
    ]);
    expect(store.log()).toHaveLength(4);
    expect(store.log(SKIPPED)).toEqual([]);
    expect(new JobStore(mkdtempSync(join(tmpdir(), 'relay-empty-'))).log()).toEqual([]);
  });
});

describe('list view', () => {
  test('shows the daemon, the counts, and the jobs table with the cursor on the newest job', () => {
    const ctx = ctxFor();
    const text = render(initialState(), ctx);
    expect(text).toContain('review-relay v0.6.0  ✓ daemon running  pid 4242 · up 2h05m · 1/2 forwarders');
    expect(text).toContain('4 jobs · 1 running · 1 done · 1 failed · 1 skipped');
    expect(text).toMatch(/STATUS\s+STARTED\s+TIME\s+REPO\s+PR\s+COMMIT\s+SOURCE\s+ROUTE\s+SCORE\s+CODEX\s+CLAUDE/);
    expect(text).toMatch(/› running\s+10-02 \d\d:00\s+3m30s\s+acme\/app\s+#7\s+aaaaaaaa/);
    expect(text).toMatch(
      / {2}done\s+.*acme\/app\s+#7\s+bbbbbbbb\s+github\s+-\s+3\/5\s+4\/5 1m05s\s+3\/5 1m30s\s+0\s+1\s+1/,
    );
    expect(text).toMatch(/ {2}failed\s+.*acme\/lib\s+#12.*risky.*codex: timed out/);
    expect(text).toContain(
      '↑↓ move · enter open · l log · r re-run · o open PR · y copy url · / filter · s status · ? help · q quit',
    );
    expect(renderTui(initialState(), ctx, styles(false), '0.6.0')).toHaveLength(30);
  });

  test('says so when the daemon is stopped and when there are no jobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-none-'));
    const ctx = ctxFor(dir, { daemon: { ...DAEMON, running: false, pid: null } });
    const text = render(initialState(), ctx);
    expect(text).toContain('✗ daemon stopped  start it with review-relay start -d');
    expect(text).toContain('no review jobs yet');
    expect(text).toContain('Jobs appear here as the daemon reviews PRs');
    expect(text).toContain('↑↓ move · / filter · s status · ? help · q quit');
    expect(render(initialState(), ctxFor(dir, { daemon: null }))).toContain('daemon …');
  });

  test('moves with the arrows, wraps, and jumps with g/G and the page keys', () => {
    const ctx = ctxFor();
    const keys = (list: TuiState) => visible(list, ctx.store.jobs).findIndex((j) => j.key === list.selected);
    expect(press(ctx, ['down']).selected).toBe(DONE.key);
    expect(keys(press(ctx, ['down', 'down', 'j', 'j']))).toBe(0);
    expect(keys(press(ctx, ['up']))).toBe(3);
    expect(keys(press(ctx, ['G']))).toBe(3);
    expect(keys(press(ctx, ['G', 'g']))).toBe(0);
    expect(keys(press(ctx, ['pagedown']))).toBe(3);
    expect(keys(press(ctx, ['pagedown', 'pageup']))).toBe(0);
    expect(render(press(ctx, ['down']), ctx)).toMatch(/› done/);
  });

  test('the cursor follows its job when newer jobs appear above it', () => {
    const dir = dataDir([DONE, FAILED]);
    const ctx = ctxFor(dir);
    const onFailed = press(ctx, ['down']);
    expect(onFailed.selected).toBe(FAILED.key);
    writeFileSync(join(dir, 'state.json'), JSON.stringify([RUNNING, DONE, FAILED]));
    ctx.store.refresh();
    expect(render(onFailed, ctx)).toMatch(/› failed/);
    // A selected job that vanished puts the cursor back on top.
    writeFileSync(join(dir, 'state.json'), JSON.stringify([RUNNING, DONE]));
    ctx.store.refresh();
    expect(render(onFailed, ctx)).toMatch(/› running/);
  });

  test('scrolls the table around the cursor on a short terminal', () => {
    const ctx = ctxFor(undefined, { height: 9 });
    const text = render(press(ctx, ['G']), ctx);
    expect(text).toMatch(/↑ \d more/);
    expect(text).toMatch(/› skipped/);
    expect(renderTui(press(ctx, ['G']), ctx, styles(false), '0.6.0')).toHaveLength(9);
  });

  test('/ filters by any column text, s cycles the status filter, esc clears them before quitting', () => {
    const ctx = ctxFor();
    const typing = press(ctx, ['/', ...'lib']);
    expect(typing.filtering).toBe(true);
    expect(typing.filter).toBe('lib');
    const text = render(typing, ctx);
    expect(text).toContain('showing 1  / lib▏');
    expect(text).toContain('type to filter · ↑↓ move · enter keep filter · esc clear it');
    expect(text).not.toContain('acme/app');
    expect(press(ctx, [...'q'], typing).done).toBeUndefined();
    const kept = press(ctx, ['enter'], typing);
    expect(kept.filtering).toBe(false);
    expect(render(kept, ctx)).toContain('/ lib');
    expect(render(kept, ctx)).toContain('esc clear filter');
    expect(press(ctx, ['escape'], kept).filter).toBeUndefined();
    expect(press(ctx, ['escape'], typing).filter).toBeUndefined();
    expect(visible(press(ctx, ['/', ...'risky', 'enter']), ctx.store.jobs)).toEqual([FAILED]);
    expect(visible(press(ctx, ['/', ...'timed', 'space', ...'out', 'enter']), ctx.store.jobs)).toEqual([FAILED]);
    expect(render(press(ctx, ['/', ...'zzz']), ctx)).toContain('no job matches the filter');

    const cycle = ['running', 'done', 'failed', 'skipped', undefined];
    let state = initialState();
    for (const status of cycle) {
      state = reduce(state, 's', ctx);
      expect(state.status).toBe(status as TuiState['status']);
    }
    const done = press(ctx, ['s', 's']);
    expect(render(done, ctx)).toContain('[done]');
    expect(visible(done, ctx.store.jobs)).toEqual([DONE]);
    expect(press(ctx, ['escape'], done).status).toBeUndefined();
    expect(press(ctx, ['escape']).done).toBe(true);
    expect(press(ctx, ['q']).done).toBe(true);
    expect(press(ctx, ['ctrl-c'], typing).done).toBe(true);
  });

  test('? opens the key help and any key closes it', () => {
    const ctx = ctxFor();
    const help = press(ctx, ['?']);
    expect(help.view).toBe('help');
    const text = render(help, ctx);
    expect(text).toContain('Keys');
    expect(text).toContain('review the PR again (asks first)');
    expect(text).toContain('any key closes help');
    expect(press(ctx, ['x'], help).view).toBe('list');
  });
});

describe('detail view', () => {
  test('shows the job, its reviewers, the merged findings, and the comment; n/p walk the list', () => {
    const ctx = ctxFor();
    const detail = press(ctx, ['down', 'enter']);
    expect(detail.view).toBe('detail');
    const text = render(detail, ctx);
    expect(text).toContain('acme/app #7  bbbbbbbb  ✓ done');
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
    expect(text).toContain('## review-relay: 3/5');
    expect(text).toContain('↑↓ scroll · n/p next/prev · l log · r re-run · o open PR · y copy url · esc back');

    const failed = press(ctx, ['n'], detail);
    expect(failed.selected).toBe(FAILED.key);
    const failedText = render(failed, ctx);
    expect(failedText).toContain('acme/lib #12  cccccccc  ✗ failed');
    expect(failedText).toContain('source    github · route risky');
    expect(failedText).toContain('error     codex: timed out after 1800s');
    expect(failedText).toContain('Log');
    expect(failedText).toContain('09:30:00 [acme/lib] PR #12: failed');
    expect(press(ctx, ['p', 'p'], failed).selected).toBe(RUNNING.key);
    expect(press(ctx, ['p', 'p', 'p'], failed).selected).toBe(RUNNING.key);
    expect(press(ctx, ['escape'], failed).view).toBe('list');
    expect(press(ctx, ['left'], failed).view).toBe('list');
  });

  test('a running job shows its elapsed time and log so far; a skipped one says why it is empty', () => {
    const ctx = ctxFor();
    const text = render(press(ctx, ['enter']), ctx);
    expect(text).toContain('acme/app #7  aaaaaaaa  ! running');
    expect(text).toContain('3m30s so far');
    expect(text).toContain('11:00:00 [acme/app] PR #7 @ aaaaaaaa: reviewing (opened)');
    expect(render(press(ctx, ['G', 'enter']), ctx)).toContain('a skip route matched, so no reviewer ran');
  });

  test('scrolls with the arrows and page keys, clamped to the content', () => {
    const ctx = ctxFor(undefined, { height: 12 });
    const detail = press(ctx, ['down', 'enter']);
    const top = render(detail, ctx);
    expect(top).toContain('acme/app #7');
    expect(top).not.toContain('## review-relay');
    const down = press(ctx, ['down', 'down', 'down'], detail);
    expect(down.scroll).toBe(3);
    expect(render(down, ctx)).not.toContain('acme/app #7  bbbbbbbb');
    const bottom = press(ctx, ['G'], detail);
    expect(render(bottom, ctx)).toContain('Looks ok.');
    expect(press(ctx, ['down'], bottom).scroll).toBe(bottom.scroll);
    expect(press(ctx, ['pageup', 'pageup', 'pageup'], bottom).scroll).toBe(0);
    expect(press(ctx, ['up'], detail).scroll).toBe(0);
  });
});

describe('log view', () => {
  test('l shows the selected job’s log lines following the end; L switches to the whole log', () => {
    const ctx = ctxFor(undefined, { height: 8 });
    const log = press(ctx, ['down', 'down', 'l']);
    expect(log.view).toBe('log');
    const text = render(log, ctx);
    expect(text).toContain('Log · acme/lib #12');
    expect(text).toContain('following');
    expect(text).toContain('09:30:00 [acme/lib] PR #12: failed');
    expect(text).not.toContain('server listening');
    expect(text).toContain('↑↓ scroll · G follow · L whole log · esc back');
    const whole = press(ctx, ['L'], log);
    const wholeText = render(whole, ctx);
    expect(wholeText).toContain('daemon.log');
    expect(wholeText).toContain('server listening');
    expect(wholeText).toContain('lines 3-4 of 4');
    expect(wholeText).toContain('L this job only');
    // Scrolling up stops following; G resumes it.
    const up = press(ctx, ['up'], whole);
    expect(up.follow).toBe(false);
    expect(render(up, ctx)).toContain('lines 2-3 of 4');
    expect(press(ctx, ['up', 'up', 'up'], whole).scroll).toBe(0);
    expect(press(ctx, ['G'], up).follow).toBe(true);
    expect(press(ctx, ['escape'], up).view).toBe('list');
    expect(render(press(ctx, ['G', 'l']), ctx)).toContain('nothing logged for this job yet');
  });
});

describe('actions', () => {
  test('r asks before re-running, y confirms with an effect, anything else cancels; running jobs refuse', () => {
    const ctx = ctxFor();
    const asked = press(ctx, ['down', 'r']);
    expect(asked.confirm).toBe('rerun');
    const text = render(asked, ctx);
    expect(text).toContain('! review acme/app #7 again with the configured reviewers?');
    expect(text).toContain('y re-run · any other key cancels');
    const go = press(ctx, ['y'], asked);
    expect(go.confirm).toBeUndefined();
    expect(go.effect).toEqual({ kind: 'rerun', job: DONE });
    // The effect is consumed by the next key.
    expect(press(ctx, ['down'], go).effect).toBeUndefined();
    const no = press(ctx, ['n'], asked);
    expect(no.effect).toBeUndefined();
    expect(no.view).toBe('list');
    expect(render(no, ctx)).toContain('cancelled');
    const busy = press(ctx, ['r']);
    expect(busy.confirm).toBeUndefined();
    expect(render(busy, ctx)).toContain('acme/app #7 is being reviewed now');
    // The flash expires.
    expect(render(busy, { ...ctx, now: NOW + 5000 })).not.toContain('is being reviewed now');
    // r works from the detail view too.
    expect(press(ctx, ['down', 'enter', 'r', 'y']).effect).toEqual({ kind: 'rerun', job: DONE });
  });

  test('o and y hand the PR url to the loop', () => {
    const ctx = ctxFor();
    expect(prUrl(FAILED)).toBe('https://github.com/acme/lib/pull/12');
    expect(press(ctx, ['o']).effect).toEqual({ kind: 'open', url: 'https://github.com/acme/app/pull/7' });
    expect(press(ctx, ['down', 'down', 'enter', 'y']).effect).toEqual({ kind: 'copy', text: prUrl(FAILED) });
    expect(press(ctx, ['o'], initialState()).view).toBe('list');
    expect(press(ctxFor(mkdtempSync(join(tmpdir(), 'relay-none-'))), ['o']).effect).toBeUndefined();
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
