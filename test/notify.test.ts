import { describe, expect, test } from 'bun:test';
import type { NotifyConfig } from '../src/config.ts';
import { desktopCommand, noticePayload, notify, sendNotice, type NotifyDeps } from '../src/notify.ts';
import type { ResolvedJob, ReviewerResult } from '../src/types.ts';
import { DIMENSIONS, type Finding, type Verdict } from '../src/verdict.ts';

const job: ResolvedJob = {
  repo: 'acme/widget',
  pr: 42,
  source: 'github',
  reason: 'pull_request opened',
  headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
  headRef: 'feat/x',
  baseRef: 'main',
};

const at = (severity: Finding['severity'], line: number): Finding => ({
  severity,
  file: 'src/a.ts',
  line,
  title: `t${line}`,
  detail: '',
  suggestion: '',
});

const reviewer = (label: string, score: number | undefined, findings: Finding[] = []): ReviewerResult => {
  const verdict: Verdict = {
    summary: '',
    score: score ?? 1,
    scoreRationale: '',
    dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 5, note: '' }])) as Verdict['dimensions'],
    findings,
  };
  return {
    name: label.toLowerCase(),
    harness: 'claude',
    label,
    timeoutMs: 1,
    ok: score !== undefined,
    output: '',
    durationMs: 1,
    ...(score !== undefined ? { score, verdict } : { error: 'boom' }),
  };
};

const config = (overrides: Partial<NotifyConfig> = {}): NotifyConfig => ({
  on: ['low', 'failed'],
  minScore: 4,
  desktop: false,
  webhook: 'https://example.com/hook',
  ...overrides,
});

describe('noticePayload', () => {
  test('low notifies under minScore only; done notifies every finished review; failed only failures', () => {
    const scored = (score: number) => ({ job, results: [reviewer('Claude', score)] });
    expect(noticePayload(config(), scored(3))?.event).toBe('done');
    expect(noticePayload(config(), scored(4))).toBeNull();
    expect(noticePayload(config({ on: ['done'] }), scored(5))?.event).toBe('done');
    expect(noticePayload(config({ on: ['done'] }), { job, error: 'boom' })).toBeNull();
    expect(noticePayload(config({ on: ['failed'] }), scored(1))).toBeNull();
    // Every reviewer failing is a failure, as everywhere else.
    expect(noticePayload(config({ on: ['failed'] }), { job, results: [reviewer('Claude', undefined)] })).toMatchObject({
      event: 'failed',
      error: 'every reviewer failed',
      text: 'Review failed: every reviewer failed',
    });
  });

  test('counts merged findings, links the comment, and leaves a local review unlinked', () => {
    const results = [
      reviewer('Claude', 2, [at('critical', 3), at('major', 40)]),
      // Same spot as Claude's critical, so it merges; the minor stands alone.
      reviewer('Codex', 4, [at('major', 4), at('minor', 90)]),
    ];
    const payload = noticePayload(config(), { job, results, commentUrl: 'https://github.com/c/1' })!;
    expect(payload).toMatchObject({
      event: 'done',
      repo: 'acme/widget',
      pr: 42,
      branch: 'feat/x',
      local: false,
      score: 2,
      findings: { critical: 1, major: 1, minor: 1 },
      reviewers: [
        { name: 'claude', label: 'Claude', ok: true, score: 2 },
        { name: 'codex', label: 'Codex', ok: true, score: 4 },
      ],
      url: 'https://github.com/c/1',
      title: 'review-relay: acme/widget #42',
      text: 'Confidence 2/5 · 1 critical, 1 major, 1 minor · Claude 2, Codex 4',
    });
    const local = noticePayload(config(), { job: { ...job, pr: 0, source: 'local' }, results })!;
    expect(local.url).toBeUndefined();
    expect(local.title).toBe('review-relay: acme/widget feat/x');
    expect(noticePayload(config(), { job, results })!.url).toBe('https://github.com/acme/widget/pull/42');
  });
});

describe('sendNotice', () => {
  const fakeDeps = (overrides: Partial<NotifyDeps> = {}) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const commands: { cmd: string[]; env?: Record<string, string> }[] = [];
    const deps: NotifyDeps = {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response('', { status: url.includes('broken') ? 500 : 200 });
      },
      exec: async (cmd, opts) => {
        commands.push({ cmd, env: opts.env });
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
      platform: 'linux',
      which: (bin) => (bin === 'notify-send' ? '/usr/bin/notify-send' : null),
      ...overrides,
    };
    return { deps, requests, commands };
  };
  const payload = noticePayload(config(), { job, results: [reviewer('Claude', 2)] })!;

  test('sends every channel its own shape and reports only the ones that failed', async () => {
    const { deps, requests, commands } = fakeDeps();
    const all = config({
      desktop: true,
      ntfy: 'https://ntfy.sh/topic',
      slack: 'https://hooks.slack.com/broken',
      webhook: 'https://example.com/hook',
    });
    expect(await sendNotice(all, payload, deps)).toEqual(['slack: HTTP 500']);
    expect(commands).toEqual([
      {
        cmd: ['/usr/bin/notify-send', '--app-name=review-relay', payload.title, payload.text],
        env: undefined,
      },
    ]);
    const byUrl = Object.fromEntries(requests.map((r) => [r.url, r.init]));
    expect(byUrl['https://ntfy.sh/topic']).toMatchObject({
      method: 'POST',
      body: payload.text,
      headers: { Title: payload.title, Tags: 'warning', Click: payload.url },
    });
    expect(JSON.parse(String(byUrl['https://hooks.slack.com/broken']!.body))).toEqual({
      text: `*${payload.title}*\n${payload.text}\n<${payload.url}|Open>`,
    });
    expect(JSON.parse(String(byUrl['https://example.com/hook']!.body))).toEqual(payload);
  });

  test('an ntfy title outside ASCII is sent as an encoded word', async () => {
    const { deps, requests } = fakeDeps();
    const title = 'review-relay: acme/widget fix/café';
    await sendNotice(config({ webhook: undefined, ntfy: 'https://ntfy.sh/t' }), { ...payload, title }, deps);
    const header = (requests[0]!.init.headers as Record<string, string>).Title!;
    expect(header).toBe(`=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`);
  });

  test('notify logs a failed channel and never throws', async () => {
    const logs: string[] = [];
    const { deps } = fakeDeps({ fetch: async () => Promise.reject(new Error('offline')) });
    await notify(config(), { job, results: [reviewer('Claude', 1)] }, (m) => logs.push(m), deps);
    expect(logs).toEqual(['review-relay: acme/widget #42: notification failed: webhook: offline']);
    // Unset, or not asked for: nothing is sent.
    await notify(undefined, { job, error: 'x' }, (m) => logs.push(m), deps);
    await notify(config({ on: ['failed'] }), { job, results: [reviewer('Claude', 1)] }, (m) => logs.push(m), deps);
    expect(logs).toHaveLength(1);
  });
});

describe('desktopCommand', () => {
  const none = () => null;

  test('picks the platform tool, falls back to the Windows toast on WSL, and passes text as data', () => {
    const mac = desktopCommand('t "x"', 'b', { platform: 'darwin', which: none })!;
    expect(mac.cmd.slice(-2)).toEqual(['t "x"', 'b']);
    expect(mac.cmd[0]).toBe('osascript');

    const wsl = desktopCommand('t', 'b', {
      platform: 'linux',
      which: (bin) => (bin === 'powershell.exe' ? '/mnt/c/ps.exe' : null),
    })!;
    expect(wsl.cmd[0]).toBe('/mnt/c/ps.exe');
    // Base64, so the code page WSLENV converts through can't mangle non-ASCII text.
    expect(wsl.env).toMatchObject({ RR_TITLE: btoa('t'), RR_TEXT: btoa('b') });
    expect(wsl.env!.WSLENV!.split(':')).toEqual(expect.arrayContaining(['RR_TITLE', 'RR_TEXT']));

    expect(desktopCommand('t', 'b', { platform: 'win32', which: none })!.cmd[0]).toBe('powershell.exe');
    expect(desktopCommand('t', 'b', { platform: 'linux', which: none })).toBeNull();
  });
});
