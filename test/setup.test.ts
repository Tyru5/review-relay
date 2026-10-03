import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { HARNESSES } from '../src/reviewers/index.ts';
import {
  formatJson,
  hasChanges,
  initialState,
  modelKeys,
  nextModels,
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

const render = (state: SetupState, ctx: SetupContext, height?: number) =>
  renderSetup(state, ctx, false, height).join('\n');

/** Keys that go from the reviewers step to the save step keeping every pick: one enter per model step. */
const walk = (ctx: SetupContext) => [
  'enter',
  ...initialState(ctx).selected.flatMap((name) => modelKeys(name).map(() => 'enter')),
];

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

  test('shows non-string model settings as text, and empty ones as the default', () => {
    expect(ctxFor({ models: { claude: { model: 5 } } }).models.claude).toEqual({ model: '5', effort: 'max' });
    const empty = ctxFor({ models: { claude: { model: '', effort: null }, codex: 'oops' } });
    expect(empty.models.claude).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(empty.models.codex).toEqual({ model: 'gpt-6-astra', effort: 'high' });
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
    expect(render(initialState(ctx), ctx)).toContain('Found 4 of 13 supported agent CLIs.');
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
    const bottom = render(press(ctx, ['up']), ctx, 20);
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

  test('enter walks a model and an effort step per selected reviewer, left goes back, and enter on save saves', () => {
    const ctx = ctxFor({});
    const codexModel = press(ctx, ['enter']);
    expect(render(codexModel, ctx)).toContain('✔ Reviewers ── ● Models 1/4 ── ○ Save');
    expect(render(codexModel, ctx)).toContain('Which model should codex (Codex CLI) use?');
    expect(render(press(ctx, ['enter'], codexModel), ctx)).toContain(
      'How much reasoning effort should codex (Codex CLI) use?',
    );
    const claudeEffort = press(ctx, ['enter', 'enter', 'enter'], codexModel);
    expect(render(claudeEffort, ctx)).toContain('● Models 4/4');
    expect(render(claudeEffort, ctx)).toContain('How much reasoning effort should claude (Claude Code) use?');
    const onSave = press(ctx, ['enter'], claudeEffort);
    expect(onSave.step).toBe(5);
    expect(render(onSave, ctx)).toContain('✔ Reviewers ── ✔ Models ── ● Save');
    expect(press(ctx, ['left'], onSave).step).toBe(4);
    expect(press(ctx, ['right'], onSave)).toEqual(onSave);
    expect(press(ctx, ['enter'], onSave).done).toBe('save');
  });

  test('a CLI with no effort setting gets a model step only', () => {
    const ctx = ctxFor({ reviewers: ['gemini'] }, ['gemini']);
    const model = press(ctx, ['enter']);
    expect(render(model, ctx)).toContain('● Models 1/1');
    expect(render(model, ctx)).toContain('Which model should gemini (Gemini CLI) use?');
    const save = press(ctx, ['enter'], model);
    expect(save.step).toBe(2);
    expect(render(save, ctx)).toContain('● Save');
  });

  test('q, escape, and ctrl-c cancel from any step', () => {
    const ctx = ctxFor({});
    for (const key of ['q', 'escape', 'ctrl-c']) {
      expect(press(ctx, [key]).done).toBe('cancel');
      expect(press(ctx, ['enter', key]).done).toBe('cancel');
      expect(press(ctx, [...walk(ctx), key]).done).toBe('cancel');
    }
  });

  test('walking through with enter alone changes nothing', () => {
    const models = { claude: { model: 'claude-opus-5-5', effort: 'max' }, codex: { effort: 'low' } };
    const ctx = ctxFor({ reviewers: ['codex', 'claude'], models });
    const state = press(ctx, walk(ctx));
    expect(state.models.codex).toEqual({ model: 'gpt-6-astra', effort: 'low' });
    expect(nextModels(state, ctx)).toEqual(models);
    expect(hasChanges(state, ctx)).toBe(false);
    expect(render(state, ctx)).toContain('Nothing changed.');
  });
});

describe('model steps', () => {
  test('list the values the CLI takes with the default marked and highlighted', () => {
    const ctx = ctxFor({ reviewers: ['claude'] });
    const text = render(press(ctx, ['enter']), ctx);
    expect(text).toContain('Common models for Claude Code; pick other to type any model id.');
    expect(text).toMatch(/› claude-opus-5-5\s+default\n/);
    expect(text).toContain('  claude-fable-5-1\n');
    expect(text).toContain('  other…');
    expect(text).toContain('↑↓ move · enter pick · ← back · q quit');
    const effort = render(press(ctx, ['enter', 'enter']), ctx);
    expect(effort).toContain('Effort levels Claude Code takes, lowest first; pick other to type another.');
    expect(effort).toMatch(/ {2}low\n.*\n.*\n.*\n\s+› max\s+default\n/);
  });

  test('picking a value writes it to the file and the save step shows the change', () => {
    const ctx = ctxFor({ reviewers: ['claude'] });
    const state = press(ctx, ['enter', 'down', 'enter', 'up', 'enter']);
    expect(state.models.claude).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh' });
    expect(nextModels(state, ctx)).toEqual({ claude: { model: 'claude-fable-5-1', effort: 'xhigh' } });
    const text = render(state, ctx);
    expect(text).toContain('Save these changes?');
    expect(text).toContain('reviewers  claude\n');
    expect(text).toContain('claude     model claude-opus-5-5 → claude-fable-5-1 · effort max → xhigh');
  });

  test('picking the default clears a value the file set, while a pinned default stays pinned', () => {
    const changed = ctxFor({
      reviewers: ['claude'],
      models: { claude: { model: 'claude-sonnet-5-5', effort: 'max' } },
    });
    const state = press(changed, ['enter', 'up', 'up', 'enter']);
    expect(state.models.claude.model).toBe('claude-opus-5-5');
    expect(nextModels(state, changed)).toEqual({ claude: { effort: 'max' } });
    expect(hasChanges(state, changed)).toBe(true);
    const pinned = ctxFor({ reviewers: ['claude'], models: { claude: { model: 'claude-opus-5-5' } } });
    const kept = press(pinned, walk(pinned));
    expect(nextModels(kept, pinned)).toEqual({ claude: { model: 'claude-opus-5-5' } });
    expect(hasChanges(kept, pinned)).toBe(false);
  });

  test('a value the file sets that is not listed leads the list and stays selectable', () => {
    const ctx = ctxFor({ reviewers: ['claude'], models: { claude: { model: 'claude-opus-4-8' } } });
    const state = press(ctx, ['enter']);
    expect(render(state, ctx)).toMatch(/› claude-opus-4-8\n\s+claude-opus-5-5\s+default\n/);
    expect(press(ctx, ['enter'], state).models.claude.model).toBe('claude-opus-4-8');
    expect(nextModels(press(ctx, ['enter'], state), ctx)).toEqual({ claude: { model: 'claude-opus-4-8' } });
  });

  test("offer the CLI's own default for a harness with none configured", () => {
    const ctx = ctxFor({ reviewers: ['pi'] }, ['pi']);
    const model = press(ctx, ['enter']);
    expect(render(model, ctx)).toContain(
      'Setup has no list for pi, so pick other to type a value, or keep its default.',
    );
    expect(render(model, ctx)).toMatch(/› pi's default\n\s+other…/);
    const effort = press(ctx, ['enter'], model);
    expect(render(effort, ctx)).toMatch(/› pi's default\n\s+off\n\s+minimal\n/);
    const picked = press(ctx, ['down', 'down', 'down', 'down', 'down', 'down', 'enter'], effort);
    expect(picked.models.pi).toEqual({ model: undefined, effort: 'xhigh' });
    expect(nextModels(picked, ctx)).toEqual({ pi: { effort: 'xhigh' } });
    expect(render(picked, ctx)).toContain("pi         model pi's default · effort pi's default → xhigh");
  });

  test('other opens a text input that takes q and the arrows as text until enter or escape', () => {
    const ctx = ctxFor({ reviewers: ['claude'] });
    const list = press(ctx, ['enter', 'up']);
    expect(render(list, ctx)).toContain('› other…');
    expect(render(list, ctx)).toContain('enter type a value');
    const typing = press(ctx, ['enter', 'q', 'w', 'e', 'n', 'left', 'up', 'space', '\x1b[1;2A'], list);
    expect(typing.done).toBeUndefined();
    expect(typing.step).toBe(list.step);
    expect(typing.typing).toBe('qwen');
    expect(render(typing, ctx)).toContain('› qwen▏');
    expect(render(typing, ctx)).toContain('type a value · enter use it · esc back to the list');
    expect(press(ctx, ['backspace'], typing).typing).toBe('qwe');
    expect(press(ctx, ['ctrl-u'], typing).typing).toBe('');
    expect(press(ctx, ['ctrl-u', 'enter'], typing)).toEqual({ ...list, typing: undefined });
    expect(press(ctx, ['ctrl-c'], typing).done).toBe('cancel');
    const back = press(ctx, ['escape'], typing);
    expect(back.done).toBeUndefined();
    expect(back.typing).toBeUndefined();
    expect(press(ctx, ['q'], back).done).toBe('cancel');
    const done = press(ctx, ['enter'], typing);
    expect(done.models.claude.model).toBe('qwen');
    expect(done.step).toBe(list.step + 1);
    expect(done.typing).toBeUndefined();
    expect(render(press(ctx, ['left'], done), ctx)).toMatch(/› qwen\n\s+claude-opus-5-5\s+default\n/);
  });

  test('leave unselected reviewers and other keys alone, and rewrite malformed values as text', () => {
    const models = { codex: { effort: 'low' }, hermes: { provider: 'nous', model: 5 }, claude: { model: 7 } };
    const ctx = ctxFor({ reviewers: ['claude'], models });
    const state = press(ctx, walk(ctx));
    expect(render(press(ctx, ['enter']), ctx)).toMatch(/› 7\n\s+claude-opus-5-5\s+default\n/);
    expect(nextModels(state, ctx)).toEqual({ ...models, claude: { model: '7' } });
    expect(hasChanges(state, ctx)).toBe(true);
  });

  test('keep an empty entry the file has and drop one whose last value is cleared', () => {
    const ctx = ctxFor({ reviewers: ['claude', 'codex'], models: { claude: {}, codex: { model: 'gpt-6-sol' } } });
    const kept = press(ctx, walk(ctx));
    expect(nextModels(kept, ctx)).toEqual({ claude: {}, codex: { model: 'gpt-6-sol' } });
    expect(hasChanges(kept, ctx)).toBe(false);
    const cleared = press(ctx, ['enter', 'enter', 'enter', 'up', 'enter', 'enter']);
    expect(nextModels(cleared, ctx)).toEqual({ claude: {} });
    expect(render(cleared, ctx)).toContain('codex      model gpt-6-sol → gpt-6-astra · effort high');
  });
});

describe('renderSetup', () => {
  test('reviewers step shows progress, selection, models, and PATH warnings', () => {
    const ctx = ctxFor(undefined, ['claude']);
    const text = render(press(ctx, ['space', 'down']), ctx);
    expect(text).toContain('/tmp/relay/config.json (new file)');
    expect(text).toContain('● Reviewers ── ○ Models ── ○ Save');
    expect(text).toMatch(/ {2}■ codex\s+Codex CLI\s+gpt-6-astra · effort high\s+not found on PATH/);
    expect(text).toMatch(/› ■ claude\s+Claude Code\s+claude-opus-5-5 · effort max\n/);
  });

  test('reviewers step shows a model picked on a later step', () => {
    const ctx = ctxFor({ reviewers: ['claude'] });
    const text = render(press(ctx, ['enter', 'down', 'enter', 'left', 'left']), ctx);
    expect(text).toMatch(/› ■ claude\s+Claude Code\s+claude-fable-5-1 · effort max\n/);
  });

  test('warns when no supported CLI is installed', () => {
    const ctx = ctxFor(undefined, []);
    expect(initialState(ctx).selected).toEqual([]);
    expect(render(initialState(ctx), ctx)).toContain('No supported agent CLI is on PATH');
  });

  test('save step shows before and after for an existing file', () => {
    const ctx = ctxFor({ reviewers: ['codex', 'claude'] });
    const text = render(press(ctx, ['space', 'enter', 'enter', 'enter']), ctx);
    expect(text).toContain('✔ Reviewers ── ✔ Models ── ● Save');
    expect(text).toContain('Save these changes?');
    expect(text).toContain('reviewers  codex, claude → claude\n');
    expect(text).toContain('claude     model claude-opus-5-5 · effort max\n');
    expect(text).toContain('enter save · ← back · q quit');
  });

  test('save step scrolls its settings rows when the terminal is short', () => {
    // Every harness selected, two of them not on PATH: 13 settings rows plus the warnings outgrow 24 lines.
    const everything = Object.keys(HARNESSES);
    const ctx = ctxFor({ reviewers: everything }, everything.slice(0, -2));
    const all = { ...initialState(ctx), selected: ctx.options };
    const save = press(ctx, ['enter', ...ctx.options.flatMap((name) => modelKeys(name).map(() => 'enter'))], all);
    const top = renderSetup(save, ctx, false, 24);
    expect(top.length).toBeLessThanOrEqual(24);
    expect(top.join('\n')).toContain('Nothing changed.');
    expect(top.join('\n')).toContain('! vibe is not on PATH');
    expect(top.join('\n')).toMatch(/codex\s+model gpt-6-astra/);
    expect(top.join('\n')).toMatch(/↓ \d+ more/);
    expect(top.join('\n')).toContain('enter exit · ↑↓ scroll · ← back · q quit');
    const bottom = render(press(ctx, ['up'], save), ctx, 24);
    expect(bottom).toMatch(/↑ \d+ more/);
    expect(bottom).toMatch(/vibe\s+model vibe's default/);
  });

  test('save step says when nothing changed', () => {
    const ctx = ctxFor({ reviewers: ['codex'] });
    const text = render(press(ctx, walk(ctx)), ctx);
    expect(text).toContain('Nothing changed.');
    expect(text).toContain('enter exit');
  });
});

test('parseKeys names arrows and control keys and splits batched input', () => {
  expect(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[D')).toEqual(['up', 'down', 'right', 'left']);
  expect(parseKeys(' \r\x1b\x03\x15')).toEqual(['space', 'enter', 'escape', 'ctrl-c', 'ctrl-u']);
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
