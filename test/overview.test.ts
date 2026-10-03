import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../src/config.ts';
import type { DaemonState } from '../src/daemon.ts';
import { HELP_GROUPS, helpWidth, renderCommandHelp, renderHelp, wrap } from '../src/help.ts';
import { renderDaemon, renderInfo } from '../src/overview.ts';
import { fmtDuration, padVisible, sanitize, styles, summarizeList, visibleLength } from '../src/ui.ts';

const plain = styles(false);
const colored = styles(true);
const opts = {
  version: '0.2.0',
  configPath: '/home/x/.review-relay/config.json',
  logPath: '/home/x/.review-relay/daemon.log',
};

const stopped: DaemonState = {
  running: false,
  pid: null,
  stale: false,
  port: 9988,
  uptimeMs: null,
  startedAt: null,
  version: null,
  health: null,
  forwarders: [],
  foreign: false,
};

const running: DaemonState = {
  ...stopped,
  running: true,
  pid: 4242,
  uptimeMs: 3_725_000,
  startedAt: '2026-10-03T10:00:00.000Z',
  version: '0.2.0',
  health: 'ok',
  forwarders: [
    {
      repo: 'Tyru5/Agendex',
      pid: 4300,
      events: 'check_run,pull_request',
      since: '2026-10-03T10:00:01.000Z',
      restarts: 2,
      alive: true,
    },
    { repo: 'o/r', pid: null, events: 'pull_request', since: '2026-10-03T10:00:01.000Z', restarts: 0, alive: false },
  ],
};

describe('renderDaemon', () => {
  test('stopped: badge, next steps, exit code 3', () => {
    const { lines, exitCode } = renderDaemon(stopped, opts, plain);
    expect(exitCode).toBe(3);
    const text = lines.join('\n');
    expect(text).toContain('✗ stopped');
    expect(text).toContain('review-relay start -d');
    expect(text).not.toContain('Forwarders');
  });

  test('stale record names the dead pid', () => {
    const { lines } = renderDaemon({ ...stopped, pid: 99, stale: true }, opts, plain);
    expect(lines.join('\n')).toContain('pid 99 is not a review-relay process');
  });

  test('foreign listener is a warning, not a failure', () => {
    const { lines } = renderDaemon({ ...stopped, foreign: true, health: 'ok' }, opts, plain);
    expect(lines.join('\n')).toContain('! stopped');
    expect(lines.join('\n')).toContain('something else answers /health on :9988');
  });

  test('running: pid, uptime, health, one row per forwarder, down count', () => {
    const { lines, exitCode } = renderDaemon(running, { ...opts, now: Date.parse('2026-10-03T10:05:01.000Z') }, plain);
    expect(exitCode).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('✓ running  pid 4242 • up 1h02m • v0.2.0');
    expect(text).toContain('http://127.0.0.1:9988/hook');
    expect(text).toContain('✓ healthy');
    expect(text).toContain('● Tyru5/Agendex  check_run,pull_request  pid 4300 • up 5m00s • 2 restarts');
    expect(text).toContain('● o/r            pull_request  no process • restarting');
    expect(text).toContain('1 of 2 forwarders down');
  });

  test('legacy daemon without a record explains the empty forwarder list', () => {
    const { lines } = renderDaemon({ ...running, version: null, forwarders: [] }, opts, plain);
    expect(lines.join('\n')).toContain('started by an older version');
  });

  test('colored output paints the padded label and the badge', () => {
    const text = renderDaemon(running, opts, colored).lines.join('\n');
    expect(text).toContain(colored.key('status'.padEnd(12)));
    expect(text).toContain(colored.badge('success', 'running'));
  });
});

describe('renderInfo', () => {
  const config = parseConfig({
    repos: [{ fullName: 'Tyru5/Agendex', localPath: '/definitely/not/here' }],
    models: { codex: { effort: 'xhigh' } },
  });

  test('lists settings, reviewers with bins, and repos with clone checks', () => {
    const text = renderInfo(
      config,
      { ...opts, bins: { codex: '/usr/bin/codex', claude: null }, configMtimeMs: null, daemon: stopped },
      plain,
    ).join('\n');
    expect(text).toContain('port        9988');
    expect(text).toContain('grace       2m00s');
    expect(text).toContain('daemon stopped; shown as it would load');
    expect(text).toContain('codex   gpt-6-astra  effort xhigh');
    expect(text).toContain('/usr/bin/codex');
    expect(text).toContain('claude  claude-opus-5-5  effort max');
    expect(text).toContain('✗ claude not on PATH');
    expect(text).toContain('trigger auto  post on  onPush off  mention @review-relay');
    expect(text).toContain('no clone here');
  });

  test('lists routes in order with what each runs and when, only for configs that route', () => {
    const routed = parseConfig({
      repos: config.repos,
      models: { haiku: { harness: 'claude' } },
      routes: [
        { name: 'docs', when: { onlyPaths: ['docs/**', '**/*.md'] }, skip: true },
        { name: 'tiny', when: { maxLines: 30, wideImpact: false }, reviewers: ['haiku'] },
      ],
    });
    const text = renderInfo(routed, { ...opts, bins: {}, configMtimeMs: null, daemon: stopped }, plain).join('\n');
    expect(text).toContain('Routes  first match wins; no match runs the reviewers above');
    expect(text).toContain('● docs  skip   onlyPaths docs/**,**/*.md');
    expect(text).toContain('● tiny  haiku  maxLines 30  wideImpact false');
    expect(text.indexOf('Routes')).toBeLessThan(text.indexOf('Repos'));

    const plainText = renderInfo(config, { ...opts, bins: {}, configMtimeMs: null, daemon: stopped }, plain).join('\n');
    expect(plainText).not.toContain('Routes');
  });

  test('flags a config edited after the daemon started', () => {
    const text = renderInfo(
      config,
      { ...opts, bins: {}, configMtimeMs: Date.parse('2026-10-03T11:00:00.000Z'), daemon: running },
      plain,
    ).join('\n');
    expect(text).toContain('edited since the daemon started; restart to apply');
  });

  test('custom reviewers show their harness and its missing executable', () => {
    const custom = parseConfig({
      repos: config.repos,
      reviewers: ['haiku', 'backup'],
      models: {
        haiku: { harness: 'claude', model: 'claude-haiku-4-5' },
        backup: { harness: 'claude' },
      },
    });
    const text = renderInfo(
      custom,
      { ...opts, bins: { haiku: '/usr/bin/claude', backup: null }, configMtimeMs: null, daemon: stopped },
      plain,
    ).join('\n');
    expect(text).toContain('haiku   claude-haiku-4-5  effort max  on claude  /usr/bin/claude');
    expect(text).toContain('backup  claude-opus-5-5  effort max  on claude  ✗ claude not on PATH');
  });
});

describe('help', () => {
  test('overview names every command once, grouped, with no color when disabled', () => {
    const text = renderHelp('0.2.0', plain, 80);
    expect(text).toContain('review-relay  v0.2.0');
    expect(text).toContain('Quick start');
    for (const group of HELP_GROUPS) {
      expect(text).toContain(group.title);
      for (const cmd of group.commands) expect(text).toMatch(new RegExp(`^  ${cmd.name} {2,}\\S`, 'm'));
    }
    expect(text).toContain('--config <path>');
    expect(text).not.toContain('\x1b[');
    expect(text).toContain('help <command>');
  });

  test('every overview line fits the width, at 60 and at 100 columns', () => {
    for (const width of [60, 100]) {
      for (const line of renderHelp('0.2.0', plain, width).split('\n')) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test('wrapped descriptions hang under the description column', () => {
    const lines = renderHelp('0.2.0', plain, 60).split('\n');
    const i = lines.findIndex((l) => l.startsWith('  --config <path>'));
    expect(i).toBeGreaterThan(0);
    const column = lines[i]!.indexOf('Config file');
    expect(lines[i + 1]!.startsWith(' '.repeat(column))).toBe(true);
    expect(lines[i + 1]!.trim().length).toBeGreaterThan(0);
  });

  test('command page shows usage, detail, options, and examples; unknown name is null', () => {
    const page = renderCommandHelp('replay', '0.2.0', plain, 80)!;
    expect(page).toContain('review-relay replay  v0.2.0');
    expect(page).toContain('Usage  review-relay replay <events.jsonl> [--dry-run] [--grace <ms>]');
    expect(page).toContain('--dry-run');
    expect(page).toContain('--config <path>');
    expect(page).toContain('$ review-relay replay events.jsonl --dry-run');
    expect(renderCommandHelp('nope', '0.2.0', plain)).toBeNull();
  });

  test('wrap and helpWidth', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('', 10)).toEqual([]);
    expect(helpWidth(40)).toBe(60);
    expect(helpWidth(200)).toBe(100);
    expect(helpWidth(undefined)).toBe(80);
  });
});

describe('ui helpers', () => {
  test('fmtDuration', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(182_000)).toBe('3m02s');
    expect(fmtDuration(7_500_000)).toBe('2h05m');
    expect(fmtDuration(97_200_000)).toBe('1d 3h');
  });

  test('padVisible ignores color codes', () => {
    expect(padVisible(colored.key('ab'), 4)).toBe(`${colored.key('ab')}  `);
    expect(visibleLength(colored.badge('success', 'ok'))).toBe(4);
  });

  test('summarizeList and sanitize', () => {
    expect(summarizeList(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d +2 more');
    expect(sanitize('\x1b[31mred\x1b[0m \x1b]0;title\x07x')).toBe('red x');
  });

  test('NO_COLOR disables color even when forced', () => {
    const prev = { no: process.env.NO_COLOR, force: process.env.FORCE_COLOR };
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '1';
    expect(styles().color).toBe(false);
    delete process.env.NO_COLOR;
    expect(styles().color).toBe(true);
    if (prev.no !== undefined) process.env.NO_COLOR = prev.no;
    if (prev.force === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prev.force;
  });
});
