import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import {
  COMMANDS,
  GLOBAL_OPTIONS,
  LOCAL_OPTIONS,
  QUICK_CONFIG,
  REPO_OPTIONS,
  REVIEWERS,
  ROUTED_CONFIG,
} from '../site/src/lib/docs.ts';
import { parseConfig } from '../src/config.ts';
import { parseNumstat } from '../src/diffstats.ts';
import { HELP_GROUPS } from '../src/help.ts';
import { HARNESS_NAMES, HARNESSES } from '../src/reviewers/index.ts';
import { pickRoute } from '../src/routes.ts';
import type { ResolvedJob } from '../src/types.ts';

describe('published documentation', () => {
  test('covers every resolved config field and gives the real defaults', () => {
    const config = parseConfig({ repos: [{ fullName: 'acme/widget', localPath: '~/code/widget' }] });
    expect(GLOBAL_OPTIONS.map(([key]) => key).toSorted()).toEqual(Object.keys(config).toSorted());
    for (const [key, value] of GLOBAL_OPTIONS) {
      if (key === 'repos' || key === 'models') continue;
      const actual = config[key as keyof typeof config];
      const documented = key === 'dataDir' ? value.replace('~', homedir()) : JSON.parse(value);
      expect(actual).toEqual(documented);
    }
    const repo = config.repos[0]!;
    const { github, ...top } = repo;
    const fields = { ...top, 'github.onPush': github.onPush, 'github.mention': github.mention };
    expect(REPO_OPTIONS.map(([key]) => key).toSorted()).toEqual(Object.keys(fields).toSorted());
    for (const [key, value] of REPO_OPTIONS) {
      if (value === 'Required') continue;
      const actual = fields[key as keyof typeof fields];
      expect(Array.isArray(actual) ? JSON.stringify(actual) : String(actual)).toBe(value);
    }
  });

  test('lists every harness with its model, effort, and product name', () => {
    expect(REVIEWERS.map(({ id }) => id).toSorted()).toEqual([...HARNESS_NAMES].toSorted());
    for (const reviewer of REVIEWERS) {
      const harness = HARNESSES[reviewer.id];
      expect(harness.product).toBe(reviewer.product);
      expect(harness.defaults.model).toBe('model' in reviewer ? reviewer.model : undefined);
      expect(harness.defaults.effort).toBe('effort' in reviewer ? reviewer.effort : undefined);
      expect(reviewer.supportsEffort).toBe(harness.choices.effort !== undefined);
    }
    const names = COMMANDS.map(([name]) => name);
    for (const command of HELP_GROUPS.flatMap((group) => group.commands)) expect(names).toContain(command.name);
  });

  test('lists the review command flags its help page lists', () => {
    const review = HELP_GROUPS.flatMap((group) => group.commands).find((command) => command.name === 'review');
    expect(LOCAL_OPTIONS.map(([flag]) => flag)).toEqual(review!.options!.map(({ flag }) => flag));
  });

  test('both copyable configs load without warnings and keep publishing off', () => {
    for (const example of [QUICK_CONFIG, ROUTED_CONFIG]) {
      const warnings: string[] = [];
      const config = parseConfig(JSON.parse(JSON.stringify(example)), (message) => warnings.push(message));
      expect(warnings).toEqual([]);
      expect(config.repos[0]?.postToPr).toBe(false);
      expect(config.reviewers).toEqual(['codex', 'claude']);
    }
  });

  test('the routing example does what its explanation promises', () => {
    const config = parseConfig(ROUTED_CONFIG);
    const job: ResolvedJob = {
      repo: 'acme/widget',
      pr: 42,
      source: 'github',
      reason: 'test',
      headSha: 'abc',
      baseRef: 'main',
    };
    const pick = (diff: string, overrides: Partial<ResolvedJob> = {}) =>
      pickRoute(config, { ...job, ...overrides }, parseNumstat(diff));

    expect(pick('5\t2\tdocs/guide.md\0').skip).toBe(true);
    expect(pick('5\t2\tdocs/guide.md\0', { source: 'mention' }).skip).toBe(false);
    expect(pick('5\t2\tAGENTS.md\0').skip).toBe(false);
    expect(pick('60\t40\tsrc/app.ts\0').reviewers).toEqual(['codex']);
    expect(pick('61\t40\tsrc/app.ts\0').reviewers).toEqual(['codex', 'claude']);
    const sensitive = pick('1\t1\tpackage.json\0');
    expect(sensitive.reviewers).toEqual(['codex-deep', 'claude']);
    expect(sensitive.timeoutMs).toBe(2400000);
    expect(pick('1\t0\tdocs/guide.md\0', { source: 'mention', route: 'sensitive' }).reviewers).toEqual([
      'codex-deep',
      'claude',
    ]);
  });
});
