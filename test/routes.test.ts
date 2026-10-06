import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../src/config.ts';
import { parseNumstat } from '../src/diffstats.ts';
import { explainRoutes, factsOf, isAgentFile, pickRoute, traceRoutes } from '../src/routes.ts';
import type { ResolvedJob } from '../src/types.ts';

const REPOS = [
  { fullName: 'Tyru5/Agendex', localPath: '/tmp/a' },
  { fullName: 'Tyru5/side-notes', localPath: '/tmp/b' },
];
const MODELS = { haiku: { harness: 'claude', model: 'claude-haiku-4-5', label: 'Haiku' } };

const config = (routes: unknown, fields: Record<string, unknown> = {}) =>
  parseConfig({ repos: REPOS, reviewers: ['codex'], models: MODELS, routes, ...fields });
const fails = (routes: unknown, fields?: Record<string, unknown>) => expect(() => config(routes, fields));
const route = (when: Record<string, unknown>, extra: Record<string, unknown> = { reviewers: ['haiku'] }) => ({
  name: 'r',
  when,
  ...extra,
});

/** Diff stats from numstat lines; a line `add\tdel\t` followed by two paths is a rename. */
const stats = (...lines: string[]) => parseNumstat([...lines, ''].join('\0'));

const job = (patch: Partial<ResolvedJob> = {}): ResolvedJob => ({
  repo: 'Tyru5/Agendex',
  pr: 7,
  source: 'github',
  reason: 'pull_request opened',
  headSha: '1e210c5c927d8d4c1e750e1fcd1f7f4e003f05f0',
  baseRef: 'main',
  ...patch,
});

/** The verdict one route gets: its detail when it matched, else `✗ ` and the first failing condition. */
function judge(when: Record<string, unknown>, files: string[], patch: Partial<ResolvedJob> = {}) {
  const [verdict] = traceRoutes(config([route(when)]).routes, factsOf(job(patch), stats(...files)));
  return verdict!.matched ? verdict!.detail : `✗ ${verdict!.detail}`;
}

describe('parseRoutes', () => {
  test('keeps what a route sets and defaults to none', () => {
    expect(config(undefined).routes).toEqual([]);
    expect(
      config([
        { name: 'docs', when: { onlyPaths: ['docs/**'] }, skip: true },
        { name: 'risky', when: { wideImpact: true, baseBranches: ['main'] }, reviewers: ['claude'], timeoutMs: 60_000 },
      ]).routes,
    ).toEqual([
      { name: 'docs', when: { onlyPaths: ['docs/**'] }, skip: true },
      {
        name: 'risky',
        when: { wideImpact: true, baseBranches: ['main'] },
        reviewers: ['claude'],
        skip: false,
        timeoutMs: 60_000,
      },
    ]);
  });

  test('stop the load on a malformed route, naming it', () => {
    fails({}).toThrow('routes must be a list');
    fails(['docs']).toThrow('routes[0] must be an object');
    fails([{ ...route({ maxLines: 1 }), name: 'Docs' }]).toThrow('routes[0]: name must be lowercase letters');
    fails([route({ maxLines: 1 }), route({ maxLines: 2 })]).toThrow('routes[1] "r": another route has this name');
    fails([{ ...route({ maxLines: 1 }), reviewer: ['haiku'] }]).toThrow('routes[0] "r": unknown key reviewer');
    fails([route({ maxLines: 1 }, { reviewers: ['haiku'], skip: false })]).toThrow('skip must be true');
    fails([route({ maxLines: 1 }, {})]).toThrow('set exactly one of reviewers and skip');
    fails([route({ onlyPaths: ['a/**'] }, { reviewers: ['haiku'], skip: true })]).toThrow('exactly one');
    fails([route({ maxLines: 1 }, { reviewers: [] })]).toThrow('reviewers must list at least one reviewer id');
    fails([route({ maxLines: 1 }, { reviewers: ['opsu'] })]).toThrow('unknown reviewer "opsu"');
    fails([route({ maxLines: 1 }, { reviewers: ['haiku', 'haiku'] })]).toThrow('lists reviewer "haiku" twice');
    fails([route({ maxLines: 1 }, { reviewers: ['haiku'], timeoutMs: 0 })]).toThrow('timeoutMs must be a positive');
  });

  test('stop the load on a malformed condition', () => {
    fails([{ name: 'r', reviewers: ['haiku'] }]).toThrow('routes[0] "r": when must be an object of conditions');
    fails([route({})]).toThrow('when needs at least one condition');
    fails([route({ path: ['a'] })]).toThrow('unknown condition path (expected repos, baseBranches, sources');
    fails([route({ paths: [] })]).toThrow('when.paths must be a non-empty list of globs');
    fails([route({ paths: 'docs/**' })]).toThrow('when.paths must be a non-empty list of globs');
    fails([route({ paths: ['src/[ab.ts'] })]).toThrow('when.paths "src/[ab.ts" has a [ or { that never closes');
    fails([route({ onlyPaths: ['src/{a,b.ts'] })]).toThrow('has a [ or { that never closes');
    fails([route({ repos: ['Tyru5/agendx'] })]).toThrow('when.repos "Tyru5/agendx" matches no configured repo');
    fails([route({ sources: ['push'] })]).toThrow(
      'when.sources must list some of greptile, coderabbit, github, mention, manual',
    );
    fails([route({ maxLines: -1 })]).toThrow('when.maxLines must be a whole number');
    fails([route({ minFiles: 1.5 })]).toThrow('when.minFiles must be a whole number');
    fails([route({ minLines: 10, maxLines: 5 })]).toThrow('when.minLines is above when.maxLines');
    fails([route({ wideImpact: 'yes' })]).toThrow('when.wideImpact must be true or false');
    // Escaped brackets are literal, and a repo glob may cover several repos.
    expect(config([route({ paths: ['src/\\[id\\].ts'], repos: ['tyru5/*'] })]).routes).toHaveLength(1);
  });

  test('a skip route may only use onlyPaths, repos, baseBranches, and sources', () => {
    const skip = { skip: true };
    fails([route({ paths: ['docs/**'] }, skip)]).toThrow(
      `routes[0] "r": skip can't use paths; it may only use onlyPaths, repos, baseBranches, sources`,
    );
    fails([route({ onlyPaths: ['docs/**'], maxLines: 10, wideImpact: false }, skip)]).toThrow(
      "skip can't use maxLines or wideImpact",
    );
    fails([route({ onlyPaths: ['docs/**'] }, { skip: true, timeoutMs: 5 })]).toThrow("skip can't use timeoutMs");
    fails([route({ sources: ['mention', 'manual'] }, skip)]).toThrow('never skips anything, because mentions and run');
    const allowed = {
      onlyPaths: ['docs/**'],
      repos: ['Tyru5/side-*'],
      baseBranches: ['gh-pages'],
      sources: ['github'],
    };
    expect(config([route(allowed, skip)]).routes[0]!.skip).toBe(true);
  });

  test('every reviewer a route can run needs a label of its own', () => {
    const models = { ...MODELS, mini: { harness: 'claude', label: 'claude' } };
    fails([route({ maxLines: 5 }, { reviewers: ['mini'] })], { reviewers: ['claude'], models }).toThrow(
      'reviewers "claude" and "mini" share the label "claude"',
    );
    fails([route({ maxLines: 5 }, { reviewers: ['claude', 'mini'] })], { models }).toThrow('share the label');
  });
});

describe('conditions', () => {
  test('repos and baseBranches match globs; repos ignore case', () => {
    expect(judge({ repos: ['tyru5/agendex'] }, ['1\t0\ta.ts'])).toBe('repo Tyru5/Agendex');
    expect(judge({ repos: ['Tyru5/side-*'] }, ['1\t0\ta.ts'])).toBe(
      '✗ repos: Tyru5/Agendex matches none of Tyru5/side-*',
    );
    expect(judge({ baseBranches: ['release/*'] }, ['1\t0\ta.ts'], { baseRef: 'release/1.2' })).toBe('base release/1.2');
    expect(judge({ baseBranches: ['release/*', 'hotfix'] }, ['1\t0\ta.ts'])).toBe(
      '✗ baseBranches: main matches none of release/*, hotfix',
    );
  });

  test('sources match the trigger', () => {
    expect(judge({ sources: ['greptile', 'github'] }, ['1\t0\ta.ts'])).toBe('source github');
    expect(judge({ sources: ['mention'] }, ['1\t0\ta.ts'])).toBe('✗ sources: github is not mention');
  });

  test('paths matches any changed path, the old path of a rename included', () => {
    const files = ['1\t0\tsrc/a.ts', '0\t0\t', 'db/migrations/001.sql', 'db/old/001.sql'];
    expect(judge({ paths: ['db/migrations/**'] }, files)).toBe('paths: db/old/001.sql');
    expect(judge({ paths: ['*.md'] }, ['1\t0\tdocs/a.md'])).toBe('✗ paths: no changed file matches *.md');
    expect(judge({ paths: ['**/*.ts'] }, ['1\t0\ta.ts', '1\t0\tb/c.ts', '1\t0\td.ts', '1\t0\te.ts'])).toBe(
      'paths: a.ts, b/c.ts, d.ts (+1 more)',
    );
  });

  test('onlyPaths needs every path of every file, and at least one file', () => {
    expect(judge({ onlyPaths: ['docs/**', '**/*.md'] }, ['3\t1\tdocs/a.md', '1\t0\tREADME.md'])).toBe(
      'onlyPaths: 2 files',
    );
    expect(judge({ onlyPaths: ['docs/**'] }, ['3\t1\tdocs/a.md', '1\t0\tsrc/app.ts'])).toBe(
      '✗ onlyPaths: src/app.ts matches none of docs/**',
    );
    // Moving code into docs/ is not a docs-only change.
    expect(judge({ onlyPaths: ['docs/**'] }, ['0\t0\t', 'src/x.ts', 'docs/x.md'])).toBe(
      '✗ onlyPaths: src/x.ts matches none of docs/**',
    );
    expect(judge({ onlyPaths: ['docs/**'] }, [])).toBe('✗ onlyPaths: no files changed');
  });

  test('size bounds are inclusive and leave lockfiles out', () => {
    const bump = ['5000\t20\tbun.lock', '20\t10\tsrc/a.ts'];
    expect(judge({ maxLines: 30 }, bump)).toBe('30 lines, at most 30');
    expect(judge({ minLines: 31 }, bump)).toBe('✗ minLines: 30 is under 31');
    expect(judge({ maxFiles: 1 }, bump)).toBe('1 file, at most 1');
    expect(judge({ minFiles: 2 }, bump)).toBe('✗ minFiles: 1 is under 2');
    expect(judge({ maxLines: 29 }, bump)).toBe('✗ maxLines: 30 is over 29');
    expect(judge({ minFiles: 1, maxFiles: 1 }, bump)).toBe('1 file, at least 1; 1 file, at most 1');
  });

  test('wideImpact matches on wide-impact files, lockfiles included, or on none', () => {
    const bump = ['5000\t20\tbun.lock', '1\t1\tpackage.json'];
    expect(judge({ wideImpact: true }, bump)).toBe('wide-impact: bun.lock, package.json');
    expect(judge({ wideImpact: false }, bump)).toBe('✗ wideImpact: bun.lock, package.json changed');
    expect(judge({ wideImpact: false }, ['1\t0\tsrc/a.ts'])).toBe('no wide-impact files');
    expect(judge({ wideImpact: true }, ['1\t0\tsrc/a.ts'])).toBe('✗ wideImpact: no wide-impact files changed');
  });

  test('every condition must hold, and the first failure in a fixed order is the one reported', () => {
    const when = { wideImpact: false, maxLines: 5, repos: ['Tyru5/side-*'] };
    expect(judge(when, ['20\t0\tsrc/a.ts'])).toBe('✗ repos: Tyru5/Agendex matches none of Tyru5/side-*');
    expect(judge({ maxLines: 50, wideImpact: false }, ['20\t0\tsrc/a.ts'])).toBe(
      '20 lines, at most 50; no wide-impact files',
    );
  });
});

describe('isAgentFile', () => {
  test('covers instruction files at any depth, agent config folders, and every harness project file', () => {
    for (const path of [
      'AGENTS.md',
      'packages/web/CLAUDE.md',
      'claude.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
      '.github/instructions/ts.instructions.md',
      '.claude/commands/deploy.md',
      '.cursor/rules/a.mdc',
      '.cursorrules',
      '.mcp.json',
      '.gemini/settings.json',
      '.agents/skills/x/SKILL.md',
      '.factory/hooks.json',
    ]) {
      expect([path, isAgentFile(path)]).toEqual([path, true]);
    }
    for (const path of ['docs/agents.txt', 'docs/a.md', 'README.md', 'src/claude.ts']) {
      expect([path, isAgentFile(path)]).toEqual([path, false]);
    }
  });
});

describe('pickRoute', () => {
  const routes = [
    { name: 'docs', when: { onlyPaths: ['docs/**', '**/*.md'] }, skip: true },
    { name: 'risky', when: { wideImpact: true }, reviewers: ['claude', 'codex'], timeoutMs: 3_600_000 },
    { name: 'tiny', when: { maxLines: 30 }, reviewers: ['haiku'] },
  ];

  test('takes the first route that matches and applies, else the fallback', () => {
    const c = config(routes);
    expect(pickRoute(c, job(), stats('1\t1\tpackage.json'))).toEqual({
      route: { name: 'risky', reason: 'wide-impact: package.json', forced: false },
      skip: false,
      reviewers: ['claude', 'codex'],
      timeoutMs: 3_600_000,
    });
    expect(pickRoute(c, job(), stats('3\t1\tdocs/a.md')).skip).toBe(true);
    expect(pickRoute(c, job(), stats('300\t0\tsrc/a.ts'))).toEqual({
      skip: false,
      reviewers: ['codex'],
      timeoutMs: 1_800_000,
    });
  });

  test('passes over a skip route for mentions, run, and agent files, and records why', () => {
    const c = config(routes);
    const facts = factsOf(job({ source: 'manual' }), stats('3\t1\tdocs/a.md'));
    expect(traceRoutes(c.routes, facts)[0]!.passedOver).toBe('run never skips');
    const agent = factsOf(job(), stats('3\t1\tdocs/a.md', '1\t0\tdocs/CLAUDE.md'));
    expect(traceRoutes(c.routes, agent)[0]!.passedOver).toBe('docs/CLAUDE.md is an agent file');
    expect(pickRoute(c, job(), stats('3\t1\tdocs/a.md', '1\t0\tdocs/CLAUDE.md')).route?.name).toBe('tiny');
  });

  test('a named route is forced; an unknown or skip name gets normal routing', () => {
    const c = config(routes);
    expect(pickRoute(c, job({ route: 'tiny' }), stats('900\t0\tsrc/a.ts')).route).toEqual({
      name: 'tiny',
      reason: 'requested with run --route',
      forced: true,
    });
    expect(pickRoute(c, job({ route: 'please' }), stats('900\t0\tsrc/a.ts')).route).toBeUndefined();
    expect(pickRoute(c, job({ route: 'docs' }), stats('3\t1\tdocs/a.md')).skip).toBe(true);
  });
});

describe('explainRoutes', () => {
  test('shows the counts, every route verdict, and the review the PR gets', () => {
    const c = config([
      { name: 'docs', when: { onlyPaths: ['docs/**'] }, skip: true },
      { name: 'risky', when: { wideImpact: true }, reviewers: ['claude', 'haiku'], timeoutMs: 3_600_000 },
      { name: 'tiny', when: { maxLines: 30 }, reviewers: ['haiku'] },
      { name: 'deps', when: { paths: ['**/package.json'] }, reviewers: ['haiku'] },
      { name: 'side', when: { repos: ['Tyru5/side-*'] }, reviewers: ['haiku'] },
    ]);
    const lines = explainRoutes(
      c,
      job(),
      stats('5000\t0\tbun.lock', '340\t25\tsrc/app.ts', '1\t1\tpackage.json', '0\t0\t', 'ci.yml', '.github/ci.yml'),
    );
    expect(lines).toEqual([
      'Tyru5/Agendex #7 @ 1e210c5c · base main · source github',
      '4 files, +5341 -26 · counted 3 files, +341 -26 (bun.lock left out)',
      'wide-impact: bun.lock, package.json, .github/ci.yml',
      '',
      '  ✗ docs   onlyPaths: bun.lock matches none of docs/**',
      '  ✔ risky  wide-impact: bun.lock, package.json, .github/ci.yml',
      '  ✗ tiny   maxLines: 367 is over 30',
      '  ✔ deps   paths: package.json, shadowed by risky',
      '  ✗ side   repos: Tyru5/Agendex matches none of Tyru5/side-*',
      '',
      'route risky · timeout 1h00m',
      '  claude  claude  claude-opus-5-5   max',
      '  haiku   claude  claude-haiku-4-5  max',
    ]);
  });

  test('says when the fallback or a skip decides, and when there are no routes', () => {
    const c = config([{ name: 'docs', when: { onlyPaths: ['docs/**'] }, skip: true }]);
    expect(explainRoutes(c, job(), stats('1\t0\tdocs/a.md')).slice(-2)).toEqual([
      '',
      'route docs · skip, so nothing runs',
    ]);
    expect(explainRoutes(c, job({ source: 'mention' }), stats('1\t0\tdocs/a.md')).slice(-4)).toEqual([
      '  - docs  matches (onlyPaths: 1 file), but a mention never skips',
      '',
      'no route matched, so reviewers runs · timeout 30m00s',
      '  codex  codex  gpt-6-astra  high',
    ]);
    expect(explainRoutes(config(undefined), job(), stats('1\t0\tsrc/a.ts')).slice(-3)).toEqual([
      'no routes configured, so every PR gets reviewers',
      'no route matched, so reviewers runs · timeout 30m00s',
      '  codex  codex  gpt-6-astra  high',
    ]);
  });
});
