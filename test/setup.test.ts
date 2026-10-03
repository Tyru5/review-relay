import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { HARNESSES } from '../src/reviewers/index.ts';
import {
  formatJson,
  hasChanges,
  initialState,
  modelKeys,
  nextModels,
  nextRepos,
  parseKeys,
  reduce,
  renderSetup,
  setupContext,
  type Disk,
  type SetupContext,
  type SetupState,
} from '../src/setup.ts';

/** The clone setup is run from, which the file lists unless a test says otherwise. */
const APP = { fullName: 'acme/app', localPath: '/home/u/app' };
/** Clones on disk: `app` and `lib` are found under ~, `tool` only when its path is typed. */
const CLONES = [
  APP,
  { fullName: 'acme/lib', localPath: '/home/u/lib' },
  { fullName: 'acme/tool', localPath: '/opt/tool' },
];
const DISK: Disk = {
  found: CLONES.slice(0, 2),
  at: (dir) => CLONES.find((clone) => clone.localPath === dir),
  here: APP,
};

/**
 * Context as if only `installed` executables were on PATH and the clones in `DISK` were on disk. An existing file
 * lists `APP` unless `raw` sets `repos` itself.
 */
const ctxFor = (raw: Record<string, any> | undefined, installed = ['claude', 'codex'], disk = DISK) =>
  setupContext(
    '/tmp/relay/config.json',
    raw && { repos: [APP], ...raw },
    (bin) => (installed.includes(bin) ? `/usr/local/bin/${bin}` : null),
    disk,
  );

/** The state on the reviewers step, past the repos step with its preselection kept. */
const atReviewers = (ctx: SetupContext) => reduce(initialState(ctx), 'enter', ctx);

const press = (ctx: SetupContext, keys: string[], state: SetupState = atReviewers(ctx)) =>
  keys.reduce((s, key) => reduce(s, key, ctx), state);

const render = (state: SetupState, ctx: SetupContext, height?: number) =>
  renderSetup(state, ctx, false, height).join('\n');

/** Keys that go from the reviewers step to the save step keeping every pick: one enter per model step. */
const walk = (ctx: SetupContext) => [
  'enter',
  ...initialState(ctx).selected.flatMap((name) => modelKeys(ctx.harnessOf[name]!).map(() => 'enter')),
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
    const ctx = ctxFor({});
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
    expect(render(atReviewers(ctx), ctx)).toContain('Found 4 of 13 supported agent CLIs.');
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
    const top = renderSetup(atReviewers(ctx), ctx, false, 20);
    expect(top.length).toBeLessThanOrEqual(20);
    expect(top.join('\n')).toMatch(/↓ \d+ more/);
    const bottom = render(press(ctx, ['up']), ctx, 20);
    expect(bottom).toMatch(/↑ \d+ more/);
    expect(bottom).toMatch(/› □ vibe/);
  });
});

describe('repos step', () => {
  test('lists configured repos first, then the clones found, and preselects the configured ones with a clone', () => {
    const ctx = ctxFor({
      repos: [
        { fullName: 'acme/lib', localPath: '/home/u/lib', trigger: 'github' },
        { fullName: 'acme/gone', localPath: '/home/u/gone' },
      ],
    });
    expect(ctx.repos.map((row) => [row.fullName, row.exists, !!row.entry])).toEqual([
      ['acme/lib', true, true],
      ['acme/gone', false, true],
      ['acme/app', true, false],
    ]);
    const state = initialState(ctx);
    // A configured repo stays selected even with no clone at its path, so the defaults never drop it.
    expect(state.repos.map((row) => row.on)).toEqual([true, true, false]);
    expect(nextRepos(state)).toEqual([
      { fullName: 'acme/lib', localPath: '/home/u/lib', trigger: 'github' },
      { fullName: 'acme/gone', localPath: '/home/u/gone' },
    ]);
    expect(hasChanges(state, ctx)).toBe(false);
    const save = press(ctx, ['enter', ...walk(ctx)], state);
    expect(render(save, ctx)).toContain('! acme/gone has no clone at /home/u/gone, so its reviews fail');
    const text = render(state, ctx);
    expect(text).toContain('● Repos ── ○ Reviewers ── ○ Models ── ○ Save');
    expect(text).toContain('Which repos should review-relay watch?');
    expect(text).toContain('Found 2 GitHub clones under ~.');
    expect(text).toMatch(/› ■ acme\/lib\s+\/home\/u\/lib\s+github\n/);
    expect(text).toMatch(/ {2}■ acme\/gone\s+\/home\/u\/gone\s+auto\s+no clone at this path\n/);
    expect(text).toMatch(/ {2}□ acme\/app\s+\/home\/u\/app\s+auto\n/);
    expect(text).toContain('other…');
    expect(text).toContain('↑↓ move · space select · enter next · q quit');
  });

  test('with no file, preselects the clone setup was run from', () => {
    const ctx = ctxFor(undefined);
    const state = initialState(ctx);
    expect(state.repos.map((row) => [row.fullName, row.on])).toEqual([
      ['acme/app', true],
      ['acme/lib', false],
    ]);
    expect(nextRepos(state)).toEqual([APP]);
    expect(state.cursor).toBe(0);
    const lib = ctxFor(undefined, undefined, { ...DISK, here: CLONES[1] });
    expect(initialState(lib).repos.map((row) => row.on)).toEqual([false, true]);
    expect(initialState(lib).cursor).toBe(1);
    expect(initialState(ctxFor(undefined, undefined, { ...DISK, here: undefined })).repos[0]!.on).toBe(false);
  });

  test('lists the clone setup was run from even when the scan missed it, and preselects it', () => {
    const tool = ctxFor(undefined, undefined, { ...DISK, here: CLONES[2] });
    const state = initialState(tool);
    expect(state.repos.map((row) => [row.fullName, row.on])).toEqual([
      ['acme/app', false],
      ['acme/lib', false],
      ['acme/tool', true],
    ]);
    expect(state.cursor).toBe(2);
    // With repos configured, the current clone is listed but the configured ones stay the selection.
    const configured = ctxFor({}, undefined, { ...DISK, here: CLONES[2] });
    expect(initialState(configured).repos.map((row) => [row.fullName, row.on])).toEqual([
      ['acme/app', true],
      ['acme/lib', false],
      ['acme/tool', false],
    ]);
  });

  test('a configured repo whose clone moved takes the path the clone was found at', () => {
    const ctx = ctxFor({ repos: [{ fullName: 'acme/lib', localPath: '~/old-lib', trigger: 'github' }] });
    expect(ctx.repos.map((row) => [row.fullName, row.localPath, row.exists])).toEqual([
      ['acme/lib', '/home/u/lib', true],
      ['acme/app', '/home/u/app', true],
    ]);
    const state = initialState(ctx);
    expect(state.repos[0]!.on).toBe(true);
    expect(nextRepos(state)).toEqual([{ fullName: 'acme/lib', localPath: '/home/u/lib', trigger: 'github' }]);
    expect(hasChanges(state, ctx)).toBe(true);
    expect(render(state, ctx)).toMatch(/› ■ acme\/lib\s+\/home\/u\/lib\s+github\s+moved\n/);
    const save = press(ctx, ['enter', ...walk(ctx)], state);
    expect(render(save, ctx)).toContain('repos      acme/lib  ~/old-lib → /home/u/lib · github\n');
  });

  test('leaves a stale repo alone when several clones of it were found, unless setup runs from one', () => {
    const twin = { fullName: 'acme/lib', localPath: '/home/u/lib2' };
    const disk: Disk = {
      ...DISK,
      found: [...DISK.found, twin],
      at: (dir) => [...CLONES, twin].find((c) => c.localPath === dir),
    };
    const file = { repos: [{ fullName: 'acme/lib', localPath: '/home/u/old-lib' }] };
    const ctx = ctxFor(file, undefined, disk);
    expect(ctx.repos.map((row) => [row.fullName, row.localPath, row.exists, row.candidates])).toEqual([
      ['acme/lib', '/home/u/old-lib', false, 2],
      ['acme/app', '/home/u/app', true, undefined],
    ]);
    expect(initialState(ctx).repos.map((row) => row.on)).toEqual([true, false]);
    expect(render(initialState(ctx), ctx)).toContain('no clone at this path; 2 found, type one under other');
    // Typing one of them moves the row there.
    const picked = press(ctx, ['up', 'enter', ...'/home/u/lib2', 'enter'], initialState(ctx));
    expect(picked.repos[0]).toMatchObject({ localPath: '/home/u/lib2', exists: true, on: true, candidates: 2 });
    expect(nextRepos(picked)).toEqual([{ fullName: 'acme/lib', localPath: '/home/u/lib2' }]);
    // Running setup from one of the clones settles it.
    const fromTwin = ctxFor(file, undefined, { ...disk, here: twin });
    expect(fromTwin.repos[0]).toMatchObject({ localPath: '/home/u/lib2', exists: true });
    expect(initialState(fromTwin).repos.map((row) => row.on)).toEqual([true, false]);
  });

  test('typing the path of a listed repo moves it there and selects it', () => {
    const ctx = ctxFor({ repos: [{ fullName: 'acme/tool', localPath: '/home/u/stale', postToPr: false }] });
    expect(ctx.repos[0]).toMatchObject({ fullName: 'acme/tool', localPath: '/home/u/stale', exists: false, on: false });
    expect(initialState(ctx).repos.map((row) => row.on)).toEqual([true, false, false]);
    const state = press(ctx, ['up', 'enter', ...'/opt/tool', 'enter'], initialState(ctx));
    expect(state.typing).toBeUndefined();
    expect(state.repos).toHaveLength(3);
    expect(state.repos[0]).toMatchObject({ fullName: 'acme/tool', localPath: '/opt/tool', exists: true, on: true });
    expect(nextRepos(state)).toEqual([{ fullName: 'acme/tool', localPath: '/opt/tool', postToPr: false }]);
    // Typing the path it already has toggles it instead.
    expect(press(ctx, ['enter', ...'/opt/tool', 'enter'], state).repos[0]!.on).toBe(false);
  });

  test('space toggles a repo, and saving keeps the configured entry as it was', () => {
    const ctx = ctxFor({ repos: [{ fullName: 'acme/app', localPath: '/home/u/app', postToPr: false }] });
    const both = press(ctx, ['down', 'space'], initialState(ctx));
    expect(nextRepos(both)).toEqual([
      { fullName: 'acme/app', localPath: '/home/u/app', postToPr: false },
      { fullName: 'acme/lib', localPath: '/home/u/lib' },
    ]);
    expect(hasChanges(both, ctx)).toBe(true);
    const none = press(ctx, ['space'], initialState(ctx));
    expect(nextRepos(none)).toEqual([]);
    expect(hasChanges(press(ctx, ['up'], both), ctx)).toBe(true);
    expect(hasChanges(press(ctx, ['down', 'space'], none), ctx)).toBe(true);
    expect(hasChanges(press(ctx, ['space'], none), ctx)).toBe(false);
  });

  test('will not leave the repos step with nothing selected', () => {
    const ctx = ctxFor({});
    const stuck = press(ctx, ['space', 'enter'], initialState(ctx));
    expect(stuck.step).toBe(0);
    expect(stuck.error).toBe('select at least one repo');
    expect(press(ctx, ['space'], stuck).error).toBeUndefined();
    expect(press(ctx, ['space', 'enter'], stuck).step).toBe(1);
  });

  test('other takes a path, adds the clone there selected, and refuses a folder with no clone', () => {
    const ctx = ctxFor({});
    const list = press(ctx, ['up'], initialState(ctx));
    expect(render(list, ctx)).toMatch(/›\s+other…/);
    expect(render(list, ctx)).toContain('enter type a path');
    const typing = press(ctx, ['enter', '/', 'o', 'p', 't', '/', 'n', 'o', 'enter'], list);
    expect(typing.typing).toBe('/opt/no');
    expect(typing.error).toBe('no GitHub clone at /opt/no');
    expect(render(typing, ctx)).toMatch(/›\s+\/opt\/no▏/);
    expect(render(typing, ctx)).toContain("type a clone's path · enter add it · esc back to the list");
    const fixed = press(ctx, ['backspace', 'backspace', 't', 'o', 'o', 'l'], typing);
    expect(fixed.error).toBeUndefined();
    const added = press(ctx, ['enter'], fixed);
    expect(added.typing).toBeUndefined();
    expect(added.repos.map((row) => [row.fullName, row.on])).toEqual([
      ['acme/app', true],
      ['acme/lib', false],
      ['acme/tool', true],
    ]);
    expect(nextRepos(added)).toEqual([APP, { fullName: 'acme/tool', localPath: '/opt/tool' }]);
    // A path to a repo already listed toggles that row instead of adding one.
    expect(added.cursor).toBe(3);
    expect(render(added, ctx)).toMatch(/›\s+other…/);
    const again = press(ctx, ['enter', '/', 'h', 'o', 'm', 'e', '/', 'u', '/', 'l', 'i', 'b', 'enter'], added);
    expect(again.repos.map((row) => row.on)).toEqual([true, true, true]);
    expect(again.repos).toHaveLength(3);
    expect(press(ctx, ['escape'], typing).typing).toBeUndefined();
  });

  test('save step lists the repos with new and removed ones marked', () => {
    const ctx = ctxFor({ repos: [APP, { fullName: 'acme/old', localPath: '/home/u/old' }] });
    const state = press(ctx, ['down', 'space', 'down', 'space', 'enter', ...walk(ctx)], initialState(ctx));
    const text = render(state, ctx);
    expect(text).toContain('Save these changes?');
    expect(text).toContain('repos      acme/app  /home/u/app · auto\n');
    expect(text).toContain('           acme/lib  /home/u/lib · auto  new\n');
    expect(text).toContain('           acme/old  removed\n');
    expect(text).toContain('reviewers  codex, claude\n');
    expect(nextRepos(state)).toEqual([APP, { fullName: 'acme/lib', localPath: '/home/u/lib' }]);
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
    expect(stuck.step).toBe(1);
    expect(stuck.error).toBe('select at least one reviewer');
    expect(press(ctx, ['space'], stuck).error).toBeUndefined();
  });

  test('enter walks a model and an effort step per selected reviewer, left goes back, and enter on save saves', () => {
    const ctx = ctxFor({});
    const codexModel = press(ctx, ['enter']);
    expect(render(codexModel, ctx)).toContain('✔ Repos ── ✔ Reviewers ── ● Models 1/4 ── ○ Save');
    expect(render(codexModel, ctx)).toContain('Which model should codex (Codex CLI) use?');
    expect(render(press(ctx, ['enter'], codexModel), ctx)).toContain(
      'How much reasoning effort should codex (Codex CLI) use?',
    );
    const claudeEffort = press(ctx, ['enter', 'enter', 'enter'], codexModel);
    expect(render(claudeEffort, ctx)).toContain('● Models 4/4');
    expect(render(claudeEffort, ctx)).toContain('How much reasoning effort should claude (Claude Code) use?');
    const onSave = press(ctx, ['enter'], claudeEffort);
    expect(onSave.step).toBe(6);
    expect(render(onSave, ctx)).toContain('✔ Repos ── ✔ Reviewers ── ✔ Models ── ● Save');
    expect(press(ctx, ['left'], onSave).step).toBe(5);
    expect(press(ctx, ['right'], onSave)).toEqual(onSave);
    expect(press(ctx, ['enter'], onSave).done).toBe('save');
  });

  test('a CLI with no effort setting gets a model step only', () => {
    const ctx = ctxFor({ reviewers: ['gemini'] }, ['gemini']);
    const model = press(ctx, ['enter']);
    expect(render(model, ctx)).toContain('● Models 1/1');
    expect(render(model, ctx)).toContain('Which model should gemini (Gemini CLI) use?');
    const save = press(ctx, ['enter'], model);
    expect(save.step).toBe(3);
    expect(render(save, ctx)).toContain('● Save');
  });

  test('q, escape, and ctrl-c cancel from any step', () => {
    const ctx = ctxFor({});
    for (const key of ['q', 'escape', 'ctrl-c']) {
      expect(press(ctx, [key], initialState(ctx)).done).toBe('cancel');
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
    expect(state.models.claude!.model).toBe('claude-opus-5-5');
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
    expect(press(ctx, ['enter'], state).models.claude!.model).toBe('claude-opus-4-8');
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
    expect(done.models.claude!.model).toBe('qwen');
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

describe('custom reviewers', () => {
  const HAIKU = { harness: 'claude', model: 'claude-haiku-4-5', label: 'Haiku' };

  test('are rows with their CLI: configured ones first, the rest after the installed CLIs', () => {
    const ctx = ctxFor({ reviewers: ['haiku', 'codex'], models: { haiku: HAIKU, spare: { harness: 'gemini' } } });
    expect(ctx.options).toEqual(['haiku', 'codex', 'claude', 'spare']);
    expect(ctx.harnessOf.haiku).toBe('claude');
    expect(ctx.models.haiku).toEqual({ model: 'claude-haiku-4-5', effort: 'max' });
    expect(initialState(ctx).selected).toEqual(['haiku', 'codex']);
    const text = render(atReviewers(ctx), ctx);
    expect(text).toMatch(/› ■ haiku\s+Claude Code\s+claude-haiku-4-5 · effort max\n/);
    expect(text).toMatch(/ {2}□ spare\s+Gemini CLI\s+default model\s+gemini not found on PATH/);
  });

  test("get their CLI's model and effort steps, and walking through changes nothing", () => {
    const ctx = ctxFor({ reviewers: ['haiku'], models: { haiku: HAIKU } });
    const model = press(ctx, ['enter']);
    expect(render(model, ctx)).toContain('Which model should haiku (Claude Code) use?');
    expect(render(model, ctx)).toMatch(/› claude-haiku-4-5\n/);
    const effort = press(ctx, ['enter'], model);
    expect(render(effort, ctx)).toContain('How much reasoning effort should haiku (Claude Code) use?');
    const save = press(ctx, ['enter'], effort);
    expect(nextModels(save, ctx)).toEqual({ haiku: HAIKU });
    expect(hasChanges(save, ctx)).toBe(false);
    expect(render(save, ctx)).toMatch(/haiku\s+model claude-haiku-4-5 · effort max/);
  });

  test('picking the CLI default clears the field and keeps harness and label', () => {
    const ctx = ctxFor({ reviewers: ['haiku'], models: { haiku: HAIKU } });
    // claude-opus-5-5, the claude default, is three rows above claude-haiku-4-5.
    const state = press(ctx, ['enter', 'up', 'up', 'up', 'enter', 'enter']);
    expect(nextModels(state, ctx)).toEqual({ haiku: { harness: 'claude', label: 'Haiku' } });
  });

  test('warn on save when their CLI is missing; invalid entries are not rows and stay in the file', () => {
    const models = { haiku: HAIKU, Bad: { harness: 'claude' }, odd: { harness: 'cursor' } };
    const ctx = ctxFor({ reviewers: ['haiku', 'codex'], models }, ['codex']);
    expect(ctx.options).toEqual(['haiku', 'codex']);
    expect(initialState(ctx).selected).toEqual(['codex']);
    const both = press(ctx, ['space']);
    expect(both.selected).toEqual(['haiku', 'codex']);
    const save = press(ctx, ['enter', 'enter', 'enter', 'enter', 'enter'], both);
    expect(render(save, ctx)).toContain(
      '! haiku runs claude, which is not on PATH, so its reviews fail until it is installed',
    );
    expect(nextModels(save, ctx)).toEqual(models);
  });
});

describe('renderSetup', () => {
  test('reviewers step shows progress, selection, models, and PATH warnings', () => {
    const ctx = ctxFor(undefined, ['claude']);
    const text = render(press(ctx, ['space', 'down']), ctx);
    expect(text).toContain('/tmp/relay/config.json (new file)');
    expect(text).toContain('✔ Repos ── ● Reviewers ── ○ Models ── ○ Save');
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
    expect(render(atReviewers(ctx), ctx)).toContain('No supported agent CLI is on PATH');
  });

  test('save step shows before and after for an existing file', () => {
    const ctx = ctxFor({ reviewers: ['codex', 'claude'] });
    const text = render(press(ctx, ['space', 'enter', 'enter', 'enter']), ctx);
    expect(text).toContain('✔ Repos ── ✔ Reviewers ── ✔ Models ── ● Save');
    expect(text).toContain('Save these changes?');
    expect(text).toContain('repos      acme/app  /home/u/app · auto\n');
    expect(text).toContain('reviewers  codex, claude → claude\n');
    expect(text).toContain('claude     model claude-opus-5-5 · effort max\n');
    expect(text).toContain('enter save · ↑↓ scroll · ← back · q quit');
  });

  test('save step scrolls its settings rows when the terminal is short', () => {
    // Every harness selected, two of them not on PATH: 13 settings rows plus the warnings outgrow 24 lines.
    const everything = Object.keys(HARNESSES);
    const ctx = ctxFor({ reviewers: everything }, everything.slice(0, -2));
    const all = { ...atReviewers(ctx), selected: ctx.options };
    const save = press(
      ctx,
      ['enter', ...ctx.options.flatMap((name) => modelKeys(ctx.harnessOf[name]!).map(() => 'enter'))],
      all,
    );
    const top = renderSetup(save, ctx, false, 24);
    expect(top.length).toBeLessThanOrEqual(24);
    expect(top.join('\n')).toContain('Nothing changed.');
    expect(top.join('\n')).toMatch(/codex\s+model gpt-6-astra/);
    expect(top.join('\n')).toMatch(/↓ \d+ more/);
    expect(top.join('\n')).toContain('enter exit · ↑↓ scroll · ← back · q quit');
    // The warnings lead the rows, so they show before anything scrolls, and scroll with them, so they never push the
    // key help off a short terminal.
    expect(top.join('\n')).toContain('! qwen is not on PATH');
    expect(top.join('\n')).toContain('! vibe is not on PATH');
    const bottom = render(press(ctx, ['up'], save), ctx, 24);
    expect(bottom).toMatch(/↑ \d+ more/);
    expect(bottom).toMatch(/vibe\s+model vibe's default/);
    expect(bottom).not.toContain('! vibe is not on PATH');
    expect(bottom).toContain('enter exit · ↑↓ scroll · ← back · q quit');
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
