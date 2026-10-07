import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';

const REPOS = [{ fullName: 'Tyru5/Agendex', localPath: '/tmp/x' }];

/** Parses `fields` with one repo, returning the config and the warnings it printed. */
function parse(fields: Record<string, unknown>) {
  const warnings: string[] = [];
  const config = parseConfig({ repos: REPOS, ...fields }, (message) => warnings.push(message));
  return { config, warnings };
}

const fails = (fields: Record<string, unknown>) => expect(() => parse(fields));

describe('reviewer entries', () => {
  test('a config without custom entries resolves to the same reviewers and models as before', async () => {
    const example = JSON.parse(await Bun.file(join(import.meta.dir, '..', 'config.example.json')).text());
    const warnings: string[] = [];
    const config = parseConfig(example, (message) => warnings.push(message));
    expect(warnings).toEqual([]);
    expect(config.reviewers).toEqual(['codex', 'claude']);
    expect(config.models.claude).toEqual({
      harness: 'claude',
      label: 'Claude',
      model: 'claude-opus-5-5',
      effort: 'max',
    });
    expect(config.models.codex).toEqual({ harness: 'codex', label: 'Codex', model: 'gpt-6-astra', effort: 'high' });
    // A CLI review-relay has no default for leaves model and effort to the CLI.
    expect(config.models.pi).toEqual({ harness: 'pi', label: 'Pi' });
  });

  test('a custom id runs its harness and falls back to that CLI defaults, never to another entry', () => {
    const { config, warnings } = parse({
      reviewers: ['claude', 'haiku', 'oc-sol'],
      models: {
        claude: { model: 'claude-sonnet-5-5', effort: 'high' },
        haiku: { harness: 'claude', model: 'claude-haiku-4-5' },
        'oc-sol': { harness: 'opencode', model: 'openai/gpt-6-sol', label: 'Sol' },
      },
    });
    expect(warnings).toEqual([]);
    expect(config.reviewers).toEqual(['claude', 'haiku', 'oc-sol']);
    expect(config.models.claude).toEqual({
      harness: 'claude',
      label: 'Claude',
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
    // Effort comes from the claude CLI's default, not from models.claude.
    expect(config.models.haiku).toEqual({
      harness: 'claude',
      label: 'haiku',
      model: 'claude-haiku-4-5',
      effort: 'max',
    });
    expect(config.models['oc-sol']).toEqual({ harness: 'opencode', label: 'Sol', model: 'openai/gpt-6-sol' });
  });

  test('a CLI name may repeat its own harness and set a label', () => {
    const { config } = parse({ models: { codex: { harness: 'codex', label: 'GPT' } } });
    expect(config.models.codex).toEqual({ harness: 'codex', label: 'GPT', model: 'gpt-6-astra', effort: 'high' });
  });

  test('an entry nothing uses is fine', () => {
    const { config, warnings } = parse({ models: { spare: { harness: 'gemini' } } });
    expect(warnings).toEqual([]);
    expect(config.models.spare).toEqual({ harness: 'gemini', label: 'spare' });
  });

  test('mistakes in a custom entry stop the load', () => {
    const custom = (entry: Record<string, unknown>, id = 'haiku') => fails({ models: { [id]: entry } });
    custom({ harness: 'claude' }, 'Haiku').toThrow('custom ids use lowercase letters, digits, and dashes');
    custom({ harness: 'claude' }, 'a'.repeat(33)).toThrow('custom ids use lowercase letters');
    custom({ harness: 'cursor' }).toThrow('models.haiku.harness must be one of claude, codex');
    custom({ harness: 'claude', modle: 'x' }).toThrow('models.haiku.modle is not a setting');
    custom({ harness: 'gemini', effort: 'high' }).toThrow('models.haiku.effort: gemini has no effort setting');
    custom({ harness: 'claude', provider: 'anthropic' }).toThrow('models.haiku.provider: only hermes takes a provider');
    custom({ harness: 'claude', model: '' }).toThrow('models.haiku.model must be a non-empty string');
    custom({ harness: 'claude', label: 5 }).toThrow('models.haiku.label must be a non-empty string');
    fails({ models: { claude: { harness: 'codex' } } }).toThrow('models.claude.harness must be "claude"');
    expect(parse({ models: { haiku: { harness: 'hermes', provider: 'nous' } } }).config.models.haiku).toEqual({
      harness: 'hermes',
      label: 'haiku',
      provider: 'nous',
    });
  });

  test('mistakes in the shapes older configs use warn and are ignored', () => {
    const { config, warnings } = parse({
      models: {
        Claude: { model: 'claude-haiku-4-5' },
        claude: { modle: 'claude-haiku-4-5', provider: 'anthropic' },
        gemini: { effort: 'high' },
        codex: 'oops',
      },
    });
    expect(warnings).toEqual([
      'models.Claude is not a CLI name and has no harness; ignored',
      'models.claude.modle is not a setting (expected harness, model, effort, provider, label); ignored',
      'models.claude.provider: only hermes takes a provider; ignored',
      'models.gemini.effort: gemini has no effort setting; ignored',
      'models.codex is not an object; ignored',
    ]);
    expect(config.models.claude).toEqual({
      harness: 'claude',
      label: 'Claude',
      model: 'claude-opus-5-5',
      effort: 'max',
    });
    expect(config.models.gemini).toEqual({ harness: 'gemini', label: 'Gemini' });
    expect(config.models.Claude).toBeUndefined();
    expect(parse({ models: ['claude'] }).warnings).toEqual(['models is not an object; ignored']);
    // A malformed value the parser has always refused still stops the load.
    fails({ models: { claude: { model: 5 } } }).toThrow('models.claude.model must be a non-empty string');
  });
});

describe('reviewers', () => {
  test('an empty list stops the load, since it would fail every review', () => {
    fails({ reviewers: [] }).toThrow('reviewers must name at least one reviewer');
    fails({ reviewers: 'claude' }).toThrow('reviewers must be a list of reviewer ids');
  });

  test('every id needs a CLI or a custom entry', () => {
    fails({ reviewers: ['claude', 'opsu'] }).toThrow('unknown reviewer "opsu" (expected a CLI name');
    fails({ reviewers: ['opus'], models: { opus: { model: 'claude-opus-5-5' } } }).toThrow(
      'unknown reviewer "opus": models.opus needs a harness naming its CLI',
    );
  });

  test('an id listed twice runs once', () => {
    const { config, warnings } = parse({ reviewers: ['claude', 'codex', 'claude'] });
    expect(config.reviewers).toEqual(['claude', 'codex']);
    expect(warnings).toEqual(['reviewers lists "claude" twice; it runs once']);
  });

  test('reviewers in use need labels that tell them apart', () => {
    const models = { mini: { harness: 'claude', label: 'claude' } };
    fails({ reviewers: ['claude', 'mini'], models }).toThrow(
      'reviewers "claude" and "mini" share the label "claude"; set a different label on one',
    );
    // A clash with a reviewer that never runs is no clash.
    expect(parse({ reviewers: ['mini'], models }).config.reviewers).toEqual(['mini']);
  });
});

describe('repo authors', () => {
  const withAuthors = (authors: unknown) => ({ repos: [{ ...REPOS[0], authors }] });

  test('defaults to every author and normalizes logins', () => {
    expect(parseConfig({ repos: REPOS }).repos[0]!.authors).toEqual([]);
    expect(parseConfig(withAuthors(['Tyru5', 'app/dependabot', 'tyru5'])).repos[0]!.authors).toEqual([
      'tyru5',
      'dependabot[bot]',
    ]);
  });

  test('rejects anything but a list of logins', () => {
    expect(() => parseConfig(withAuthors('tyru5'))).toThrow('repos[0].authors');
    expect(() => parseConfig(withAuthors(['']))).toThrow('repos[0].authors');
    expect(() => parseConfig(withAuthors([7]))).toThrow('repos[0].authors');
  });
});
