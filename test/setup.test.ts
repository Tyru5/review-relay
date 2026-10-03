import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  formatJson,
  hasChanges,
  initialState,
  parseKeys,
  reduce,
  renderSetup,
  setupContext,
  type SetupContext,
  type SetupState,
} from '../src/setup.ts';

/** Context as if only `installed` executables were on PATH. */
const ctxFor = (raw: Record<string, any> | undefined, installed = ['claude', 'codex']) =>
  setupContext('/tmp/relay/config.json', raw, (bin) => (installed.includes(bin) ? `/usr/local/bin/${bin}` : null));

const press = (ctx: SetupContext, keys: string[], state: SetupState = initialState(ctx)) =>
  keys.reduce((s, key) => reduce(s, key, ctx), state);

describe('setupContext', () => {
  test('with no file, preselects the default reviewers', () => {
    const ctx = ctxFor(undefined);
    expect(ctx.raw).toBeUndefined();
    expect(ctx.options).toEqual(['codex', 'claude']);
    expect(initialState(ctx).selected).toEqual(['codex', 'claude']);
    expect(ctx.models.claude).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(hasChanges(initialState(ctx), ctx)).toBe(true);
  });

  test('keeping the default selection is no change when the file leaves reviewers unset', () => {
    const ctx = ctxFor({ repos: [] });
    expect(hasChanges(initialState(ctx), ctx)).toBe(false);
  });

  test('lists configured reviewers first and preselects only those', () => {
    const ctx = ctxFor({ reviewers: ['claude'], models: { codex: { effort: 'low' } } });
    expect(ctx.options).toEqual(['claude', 'codex']);
    expect(initialState(ctx).selected).toEqual(['claude']);
    expect(ctx.models.codex).toEqual({ model: 'gpt-6-astra', effort: 'low' });
  });

  test('drops unknown reviewers from the selection, which counts as a change', () => {
    const ctx = ctxFor({ reviewers: ['gemini', 'codex'] });
    const state = initialState(ctx);
    expect(state.selected).toEqual(['codex']);
    expect(hasChanges(state, ctx)).toBe(true);
  });

  test('reads a bare string as one reviewer and saving rewrites it as a list', () => {
    const ctx = ctxFor({ reviewers: 'claude' });
    const state = initialState(ctx);
    expect(state.selected).toEqual(['claude']);
    expect(hasChanges(state, ctx)).toBe(true);
  });

  test('shows non-string model settings as text instead of failing', () => {
    expect(ctxFor({ models: { claude: { model: 5 } } }).models.claude).toEqual({ model: '5', effort: 'max' });
  });

  test('lists a configured reviewer that is not installed but leaves it unselected', () => {
    const ctx = ctxFor({ reviewers: ['codex', 'claude'] }, ['claude']);
    expect(ctx.options).toEqual(['codex', 'claude']);
    expect(ctx.installed).toEqual({ claude: '/usr/local/bin/claude' });
    expect(initialState(ctx).selected).toEqual(['claude']);
  });
});

describe('detection', () => {
  test('lists every installed harness after the configured ones and names the rest as not installed', () => {
    const ctx = ctxFor(undefined, ['claude', 'codex', 'pi', 'grok']);
    expect(ctx.options).toEqual(['codex', 'claude', 'grok', 'pi']);
    expect(ctx.notFound).not.toContain('pi');
    expect(ctx.notFound).toContain('gemini');
    expect(initialState(ctx).selected).toEqual(['codex', 'claude']);
    expect(renderSetup(initialState(ctx), ctx, false).join('\n')).toContain('Found 4 of 13 supported agent CLIs.');
  });

  test('preselects the first installed harness when no default one is installed', () => {
    const ctx = ctxFor(undefined, ['pi']);
    expect(ctx.options).toEqual(['codex', 'claude', 'pi']);
    expect(initialState(ctx).selected).toEqual(['pi']);
  });

  test('finds a harness under any of its executable names', () => {
    expect(ctxFor({}, ['kilocode']).installed.kilo).toBe('/usr/local/bin/kilocode');
  });

  test('scrolls the list to keep the cursor in view when the terminal is short', () => {
    const everything = [
      'claude',
      'codex',
      'auggie',
      'copilot',
      'droid',
      'gemini',
      'grok',
      'hermes',
      'kilo',
      'opencode',
      'pi',
      'qwen',
      'vibe',
    ];
    const ctx = ctxFor(undefined, everything);
    const top = renderSetup(initialState(ctx), ctx, false, 20);
    expect(top.length).toBeLessThanOrEqual(20);
    expect(top.join('\n')).toMatch(/↓ \d+ more/);
    const bottom = renderSetup(press(ctx, ['up']), ctx, false, 20).join('\n');
    expect(bottom).toMatch(/↑ \d+ more/);
    expect(bottom).toMatch(/› □ vibe/);
  });
});

describe('reduce', () => {
  test('space toggles the highlighted reviewer and keeps display order', () => {
    const ctx = ctxFor({ reviewers: ['claude', 'codex'] });
    expect(press(ctx, ['space']).selected).toEqual(['codex']);
    expect(press(ctx, ['down', 'space']).selected).toEqual(['claude']);
    expect(press(ctx, ['space', 'space']).selected).toEqual(['claude', 'codex']);
    expect(press(ctx, ['up']).cursor).toBe(1);
  });

  test('will not leave the reviewers step with nothing selected', () => {
    const ctx = ctxFor({});
    const stuck = press(ctx, ['space', 'down', 'space', 'enter']);
    expect(stuck.step).toBe(0);
    expect(stuck.error).toBe('select at least one reviewer');
    expect(press(ctx, ['space'], stuck).error).toBeUndefined();
  });

  test('enter moves forward, left goes back, and enter on the last step saves', () => {
    const ctx = ctxFor({});
    const onSave = press(ctx, ['enter']);
    expect(onSave.step).toBe(1);
    expect(press(ctx, ['left'], onSave).step).toBe(0);
    expect(press(ctx, ['right'], onSave)).toEqual(onSave);
    expect(press(ctx, ['enter'], onSave).done).toBe('save');
  });

  test('q, escape, and ctrl-c cancel from any step', () => {
    const ctx = ctxFor({});
    for (const key of ['q', 'escape', 'ctrl-c']) {
      expect(press(ctx, [key]).done).toBe('cancel');
      expect(press(ctx, ['enter', key]).done).toBe('cancel');
    }
  });
});

describe('renderSetup', () => {
  test('reviewers step shows progress, selection, models, and PATH warnings', () => {
    const ctx = ctxFor(undefined, ['claude']);
    const text = renderSetup(press(ctx, ['space', 'down']), ctx, false).join('\n');
    expect(text).toContain('/tmp/relay/config.json (new file)');
    expect(text).toContain('● Reviewers ── ○ Save');
    expect(text).toMatch(/ {2}■ codex\s+Codex CLI\s+gpt-6-astra · effort high\s+not found on PATH/);
    expect(text).toMatch(/› ■ claude\s+Claude Code\s+claude-opus-5-5 · effort max\n/);
  });

  test('warns when no supported CLI is installed', () => {
    const ctx = ctxFor(undefined, []);
    expect(initialState(ctx).selected).toEqual([]);
    expect(renderSetup(initialState(ctx), ctx, false).join('\n')).toContain('No supported agent CLI is on PATH');
  });

  test('save step shows before and after for an existing file', () => {
    const ctx = ctxFor({ reviewers: ['codex', 'claude'] });
    const text = renderSetup(press(ctx, ['space', 'enter']), ctx, false).join('\n');
    expect(text).toContain('✔ Reviewers ── ● Save');
    expect(text).toContain('Save these changes?');
    expect(text).toContain('reviewers  codex, claude → claude');
    expect(text).toContain('enter save · ← back · q quit');
  });

  test('save step says when nothing changed', () => {
    const ctx = ctxFor({ reviewers: ['codex'] });
    const text = renderSetup(press(ctx, ['enter']), ctx, false).join('\n');
    expect(text).toContain('Nothing changed.');
    expect(text).toContain('enter exit');
  });
});

test('parseKeys names arrows and control keys and splits batched input', () => {
  expect(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[D')).toEqual(['up', 'down', 'right', 'left']);
  expect(parseKeys(' \r\x1b\x03')).toEqual(['space', 'enter', 'escape', 'ctrl-c']);
  expect(parseKeys('jjq')).toEqual(['j', 'j', 'q']);
  expect(parseKeys('\x1b[1;2A')).toEqual(['\x1b[1;2A']);
});

describe('formatJson', () => {
  test('reproduces config.example.json exactly', async () => {
    const text = await Bun.file(join(import.meta.dir, '..', 'config.example.json')).text();
    expect(`${formatJson(JSON.parse(text))}\n`).toBe(text);
  });

  test('keeps the top level expanded and long objects multi-line', () => {
    expect(formatJson({ reviewers: ['claude'] })).toBe('{\n  "reviewers": ["claude"]\n}');
    expect(formatJson({ a: { long: 'x'.repeat(80) } })).toBe(`{\n  "a": {\n    "long": "${'x'.repeat(80)}"\n  }\n}`);
    expect(formatJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}');
  });
});
