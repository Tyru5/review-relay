import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { DEFAULT_MODELS, DEFAULT_REVIEWERS, REVIEWER_ID, type ModelConfig } from './config.ts';
import { cloneAround, cloneAt, discoverClones, type Clone } from './repos.ts';
import { findBin, HARNESS_NAMES, HARNESSES, isHarness } from './reviewers/index.ts';
import type { HarnessName, ReviewerId } from './types.ts';

/** The `models` keys setup configures, in the order their steps run. */
export type ModelKey = 'model' | 'effort';

/** What setup found on disk; the pieces that touch the file system, so tests can stand in for them. */
export interface Disk {
  /** GitHub clones found under the home folder. */
  found: Clone[];
  /** The clone at a folder the user names, or undefined when there is none. */
  at: (dir: string) => Clone | undefined;
  /** The clone setup was run from, listed even when the scan missed it and preselected when the file lists no repos. */
  here?: Clone;
}

/** A row on the repos step. */
export interface RepoOption extends Clone {
  /** The file's entry for this repo, kept as is (trigger and the rest) when saving, except for a changed `localPath`. */
  entry?: Record<string, any>;
  /** False for a configured repo with no clone at its path. */
  exists: boolean;
  /** For a configured repo with no clone at its path, how many clones of it were found: more than one is for the user to pick from. */
  candidates?: number;
  on: boolean;
}

export interface SetupContext {
  path: string;
  /** The parsed config file, or undefined when saving creates it. */
  raw: Record<string, any> | undefined;
  /** The file's `repos` entries that name a repo, in order. */
  currentRepos: Record<string, any>[];
  /** Rows on the repos step: configured repos first, so saving keeps their order, then every clone found. */
  repos: RepoOption[];
  disk: Disk;
  /** `reviewers` as the file lists them, or the default when unset. */
  current: string[];
  /**
   * Rows on the reviewers step: configured reviewers first, so saving keeps their order, then every installed CLI,
   * then the file's other custom reviewers.
   */
  options: ReviewerId[];
  /** The CLI each reviewer runs: a CLI name runs itself, and a custom entry names its CLI in `harness`. */
  harnessOf: Record<ReviewerId, HarnessName>;
  /** Executable found on PATH for each installed harness. */
  installed: Partial<Record<HarnessName, string>>;
  /** Supported harnesses that are neither installed nor configured, named under the list. */
  notFound: HarnessName[];
  /** Each reviewer's model and effort as reviews would use them: the file's values over the harness defaults. */
  models: Record<ReviewerId, ModelConfig>;
}

export interface SetupState {
  /** Index into `steps`. */
  step: number;
  /** Highlighted row on list steps. */
  cursor: number;
  /** Like `SetupContext.repos`, with the user's toggles and typed paths applied. */
  repos: RepoOption[];
  selected: ReviewerId[];
  /** Like `SetupContext.models`, with the user's picks applied. */
  models: Record<ReviewerId, ModelConfig>;
  /** The text typed on a list step after picking "other"; undefined while its list is shown. */
  typing?: string;
  /** Text narrowing the repos step to the rows whose name or path contains it; undefined when none is set. */
  filter?: string;
  /** True while the filter input on the repos step takes the keys. */
  filtering?: boolean;
  /** Why the current step can't be left yet. */
  error?: string;
  done?: 'save' | 'cancel';
}

type Paint = (code: string, text: string) => string;

/** Items on the progress line; every model step belongs to the one `Models` item. */
type Group = 'Repos' | 'Reviewers' | 'Models' | 'Save';
const GROUPS: Group[] = ['Repos', 'Reviewers', 'Models', 'Save'];

interface Step {
  group: Group;
  /** `height` is how many lines the body may use before the terminal would scroll. */
  body(state: SetupState, ctx: SetupContext, paint: Paint, height: number): string[];
  /** Key help shown at the bottom. */
  hint(state: SetupState, ctx: SetupContext): string;
  /** Row to highlight when the step is entered; the top one by default. */
  cursor?(state: SetupState, ctx: SetupContext): number;
  /** Step-specific keys, tried before the common ones; returns `state` itself when the key does nothing here. */
  onKey?(state: SetupState, key: string, ctx: SetupContext): SetupState;
  /** Message that keeps the user on this step, or undefined to let them continue. */
  validate?(state: SetupState): string | undefined;
  /** Applies the step's result as the user continues past it. */
  leave?(state: SetupState, ctx: SetupContext): SetupState;
}

const BOLD = '1';
const DIM = '2';
const GREEN = '32';
const YELLOW = '33';
const CYAN = '36';

/** `value` when it is a plain object, else an empty one, so a malformed config section reads as unset. */
const plain = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};

/** A config value as text; empty and null count as unset. */
const asText = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : String(value));

/** The rows that fit in `room` lines, kept around the cursor, with markers for what scrolled out of view. */
function windowed(rows: string[], cursor: number, room: number, paint: Paint): string[] {
  if (rows.length <= room) return rows;
  const size = Math.max(1, room - 2);
  const start = Math.min(Math.max(0, cursor - Math.floor(size / 2)), rows.length - size);
  const below = rows.length - start - size;
  return [
    paint(DIM, start > 0 ? `  ↑ ${start} more` : ''),
    ...rows.slice(start, start + size),
    paint(DIM, below > 0 ? `  ↓ ${below} more` : ''),
  ];
}
const tildify = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
const untildify = (path: string) => resolvePath(path.replace(/^~(?=\/|$)/, homedir()));

const NO_DISK: Disk = { found: [], at: () => undefined };

/** The file's `repos` entries setup can show: objects with a `fullName`. Others are dropped on save. */
const listRepos = (raw: Record<string, any> | undefined): Record<string, any>[] =>
  (Array.isArray(raw?.repos) ? raw.repos : []).filter(
    (entry: unknown) => typeof plain(entry).fullName === 'string' && plain(entry).fullName,
  );

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The path an entry sets, as the row compares it. */
const entryPath = (entry: Record<string, any>) => untildify(asText(entry.localPath) ?? '');

/**
 * A configured row whose path has no clone, moved to where its clone is now when that is unambiguous: the clone
 * setup runs from, or the only clone of that repo found. With several found and none current, the row stays put and
 * counts them, so the user picks one by typing its path.
 */
function relocate(row: RepoOption, disk: Disk): RepoOption {
  if (row.exists) return row;
  const matches = disk.found.filter((clone) => sameRepo(clone.fullName, row.fullName));
  const here = disk.here && sameRepo(disk.here.fullName, row.fullName) ? disk.here : undefined;
  const clone = here ?? (matches.length === 1 ? matches[0] : undefined);
  return clone ? { ...row, localPath: clone.localPath, exists: true } : { ...row, candidates: matches.length };
}

/**
 * Rows on the repos step: the file's repos (first entry per name, moved to their clone when it is elsewhere), then
 * the clones found and the clone setup runs from when they aren't among them.
 */
function repoOptions(current: Record<string, any>[], disk: Disk): RepoOption[] {
  const rows: RepoOption[] = [];
  for (const entry of current) {
    if (rows.some((row) => sameRepo(row.fullName, entry.fullName))) continue;
    const localPath = entryPath(entry);
    rows.push(relocate({ fullName: entry.fullName, localPath, entry, exists: !!disk.at(localPath), on: false }, disk));
  }
  for (const clone of [...disk.found, ...(disk.here ? [disk.here] : [])]) {
    if (!rows.some((row) => sameRepo(row.fullName, clone.fullName))) rows.push({ ...clone, exists: true, on: false });
  }
  return rows;
}

/**
 * The file's custom reviewers, with the CLI each runs: entries under a valid id that isn't a CLI name, whose
 * `harness` names a supported CLI. Setup edits their model and effort but never creates or removes one.
 */
const customReviewers = (raw: Record<string, any> | undefined): [ReviewerId, HarnessName][] =>
  Object.entries(plain(raw?.models)).flatMap(([id, entry]): [ReviewerId, HarnessName][] => {
    const harness = plain(entry).harness;
    return !isHarness(id) && REVIEWER_ID.test(id) && isHarness(harness) ? [[id, harness]] : [];
  });

/**
 * `raw` is the parsed config file, or undefined when there is none yet. `which` looks an executable up on PATH, and
 * `disk` is what the scan for clones found.
 */
export function setupContext(
  path: string,
  raw: Record<string, any> | undefined,
  which: (bin: string) => string | null,
  disk: Disk = NO_DISK,
): SetupContext {
  // A bare string (a slip for a one-item list) shows as that one reviewer.
  const current = [raw?.reviewers ?? DEFAULT_REVIEWERS].flat().map(String);
  const currentRepos = listRepos(raw);
  const installed: SetupContext['installed'] = {};
  for (const name of HARNESS_NAMES) {
    const bin = findBin(name, which);
    if (bin) installed[name] = bin;
  }
  const custom = customReviewers(raw);
  const harnessOf: Record<ReviewerId, HarnessName> = Object.fromEntries([
    ...HARNESS_NAMES.map((name) => [name, name]),
    ...custom,
  ]);
  const known = (id: string) => Object.hasOwn(harnessOf, id);
  const options = [
    ...new Set([
      ...current.filter(known),
      ...HARNESS_NAMES.filter((name) => installed[name]),
      ...custom.map(([id]) => id),
    ]),
  ];
  const models = Object.fromEntries(
    Object.entries(harnessOf).map(([id, harness]) => {
      const file = plain(plain(raw?.models)[id]);
      const model = asText(file.model) ?? DEFAULT_MODELS[harness].model;
      const effort = asText(file.effort) ?? DEFAULT_MODELS[harness].effort;
      return [id, { model, effort }];
    }),
  ) as Record<ReviewerId, ModelConfig>;
  return {
    path,
    raw,
    currentRepos,
    repos: repoOptions(currentRepos, disk),
    disk,
    current,
    options,
    harnessOf,
    installed,
    notFound: HARNESS_NAMES.filter((name) => !options.includes(name)),
    models,
  };
}

/**
 * Preselects the configured repos (even one whose clone is missing, so accepting the defaults never drops a repo),
 * else the clone setup was run from; and the configured (or default) reviewers that are installed, else the first
 * installed harness.
 */
export function initialState(ctx: SetupContext): SetupState {
  const configured = ctx.repos.filter((row) => row.entry);
  const here = ctx.disk.here && ctx.repos.find((row) => sameRepo(row.fullName, ctx.disk.here!.fullName));
  const start = configured.length > 0 ? configured : here ? [here] : [];
  const repos = ctx.repos.map((row) => ({ ...row, on: start.includes(row) }));
  const runs = (id: ReviewerId) => !!ctx.installed[ctx.harnessOf[id]!];
  const usable = ctx.options.filter((id) => ctx.current.includes(id) && runs(id));
  const first = ctx.options.find(runs);
  const models = Object.fromEntries(
    Object.keys(ctx.harnessOf).map((id) => [id, { ...ctx.models[id] }]),
  ) as SetupState['models'];
  const state = { step: 0, cursor: 0, repos, selected: usable.length > 0 ? usable : first ? [first] : [], models };
  return { ...state, cursor: REPOS_STEP.cursor!(state, ctx) };
}

/** Why a configured row can't be selected as it is, with the way out when several clones of it were found. */
const missing = (row: RepoOption) =>
  (row.candidates ?? 0) > 1
    ? `no clone at this path; ${row.candidates} found, type one under other`
    : 'no clone at this path';

/** True for a configured row whose path setup changed, by finding its clone elsewhere or being told where it is. */
const moved = (row: RepoOption) => !!row.entry && entryPath(row.entry) !== row.localPath;

/**
 * The file's `repos` after the toggles: configured entries as they were (with the new path when the row moved), and
 * a new clone as a minimal entry.
 */
export const nextRepos = (state: SetupState): Record<string, any>[] =>
  state.repos
    .filter((row) => row.on)
    .map((row) =>
      !row.entry
        ? { fullName: row.fullName, localPath: tildify(row.localPath) }
        : moved(row)
          ? { ...row.entry, localPath: tildify(row.localPath) }
          : row.entry,
    );

/** The trigger mode a repo's entry sets, or the default. */
const triggerOf = (row: RepoOption) => asText(row.entry?.trigger) ?? 'auto';

/** The keys a reviewer's model steps set, by the CLI it runs: `effort` only when the CLI takes one. */
export const modelKeys = (harness: HarnessName): ModelKey[] =>
  HARNESSES[harness].choices.effort ? ['model', 'effort'] : ['model'];

/**
 * The file's `models` with the picks applied. Unselected reviewers and keys the steps don't set (`provider`) stay as
 * they were, and a pick equal to the harness default clears the key rather than pinning it.
 */
export function nextModels(state: SetupState, ctx: SetupContext): Record<string, any> {
  const file = plain(ctx.raw?.models);
  const next = { ...file };
  for (const name of state.selected) {
    const harness = ctx.harnessOf[name]!;
    // A custom entry keeps `harness` and `label`, so it is never dropped as empty.
    const entry = { ...plain(file[name]) };
    for (const key of modelKeys(harness)) {
      const value = state.models[name]![key];
      // Strict equality keeps a value the file pins, and still rewrites a malformed one (a number) as text.
      if (value === entry[key]) continue;
      if (value === undefined || value === DEFAULT_MODELS[harness][key]) delete entry[key];
      else entry[key] = value;
    }
    if (Object.keys(entry).length > 0 || JSON.stringify(entry) === JSON.stringify(file[name])) next[name] = entry;
    else delete next[name];
  }
  return next;
}

/** Compares against the file's own values, so saving also repairs a malformed `reviewers` or `models`. */
export const hasChanges = (state: SetupState, ctx: SetupContext) =>
  !ctx.raw ||
  JSON.stringify(nextRepos(state)) !== JSON.stringify(ctx.raw.repos ?? []) ||
  JSON.stringify(state.selected) !== JSON.stringify(ctx.raw.reviewers ?? DEFAULT_REVIEWERS) ||
  JSON.stringify(nextModels(state, ctx)) !== JSON.stringify(plain(ctx.raw.models));

interface Row {
  /** The setting this row stands for; undefined leaves it to the CLI. Absent on the "other" row. */
  value?: string;
  label: string;
  note?: string;
  /** The row that opens the text input. */
  other?: boolean;
}

/** The current pick and the file's value lead when they aren't listed, so they stay visible and selectable. */
export function modelRows(name: ReviewerId, field: ModelKey, state: SetupState, ctx: SetupContext): Row[] {
  const harness = ctx.harnessOf[name]!;
  const fallback = DEFAULT_MODELS[harness][field];
  const listed = HARNESSES[harness].choices[field] ?? [];
  const extra = [state.models[name]![field], ctx.models[name]![field]].filter(
    (value): value is string => !!value && !listed.includes(value),
  );
  return [
    ...[...new Set(extra)].map((value) => ({ value, label: value })),
    ...(fallback ? [] : [{ label: `${HARNESSES[harness].bins[0]}'s default` }]),
    ...listed.map((value) => ({ value, label: value, note: value === fallback ? 'default' : undefined })),
    { label: 'other…', other: true },
  ];
}

const setModel = (state: SetupState, name: ReviewerId, field: ModelKey, value: string | undefined): SetupState => ({
  ...state,
  models: { ...state.models, [name]: { ...state.models[name], [field]: value } },
  typing: undefined,
});

/** Keys while a text input is open: editing keys, escape back to the list, and enter handing the text to `use`. */
function typed(state: SetupState, key: string, use: (text: string) => SetupState): SetupState {
  const text = state.typing!;
  if (key === 'escape') return { ...state, typing: undefined };
  if (key === 'backspace') return { ...state, typing: text.slice(0, -1) };
  if (key === 'ctrl-u') return { ...state, typing: '' };
  // An empty input is a change of mind, back to the list.
  if (key === 'enter') return text ? use(text) : { ...state, typing: undefined };
  // Printable characters only; named keys, escape sequences, and control characters do nothing.
  return key.length === 1 && key > ' ' ? { ...state, typing: text + key } : state;
}

/** Moves the cursor over `n` rows, wrapping; or returns `state` when `key` isn't a movement. */
function move(state: SetupState, key: string, n: number): SetupState {
  if (n === 0) return state;
  if (key === 'up' || key === 'k') return { ...state, cursor: (state.cursor + n - 1) % n };
  if (key === 'down' || key === 'j') return { ...state, cursor: (state.cursor + 1) % n };
  return state;
}

/** The step that picks one reviewer's model or effort: a list of values, with "other" opening a text input. */
function modelStep(name: ReviewerId, harness: HarnessName, field: ModelKey): Step {
  const { product, choices } = HARNESSES[harness];
  const rows = (state: SetupState, ctx: SetupContext) => modelRows(name, field, state, ctx);
  return {
    group: 'Models',
    body: (state, ctx, paint, height) => {
      const list = rows(state, ctx);
      const width = Math.max(...list.map((row) => row.label.length));
      const lines = list.map((row, i) => {
        const active = i === state.cursor;
        const label = row.other && state.typing !== undefined ? `${state.typing}▏` : row.label;
        return [
          active ? paint(CYAN, '›') : ' ',
          paint(active ? BOLD : '', label.padEnd(width)),
          row.note ? paint(DIM, row.note) : '',
        ]
          .join(' ')
          .trimEnd();
      });
      const question =
        field === 'model'
          ? `Which model should ${name} (${product}) use?`
          : `How much reasoning effort should ${name} (${product}) use?`;
      const intro =
        (choices[field] ?? []).length === 0
          ? `Setup has no list for ${product}, so pick other to type a value, or keep its default.`
          : field === 'model'
            ? `Common models for ${product}; pick other to type any model id.`
            : `Effort levels ${product} takes, lowest first; pick other to type another.`;
      return [question, paint(DIM, intro), '', ...windowed(lines, state.cursor, height - 3, paint)];
    },
    hint: (state, ctx) => {
      if (state.typing !== undefined) return 'type a value · enter use it · esc back to the list';
      return `↑↓ move · enter ${rows(state, ctx)[state.cursor]?.other ? 'type a value' : 'pick'} · ← back · q quit`;
    },
    cursor: (state, ctx) =>
      Math.max(
        0,
        rows(state, ctx).findIndex((row) => !row.other && row.value === state.models[name]![field]),
      ),
    onKey: (state, key, ctx) => {
      if (state.typing !== undefined) {
        return typed(state, key, (text) => goTo(setModel(state, name, field, text), state.step + 1, ctx));
      }
      const list = rows(state, ctx);
      const stepped = move(state, key, list.length);
      if (stepped !== state) return stepped;
      if ((key === 'enter' || key === 'right') && list[state.cursor]?.other) return { ...state, typing: '' };
      return state;
    },
    leave: (state, ctx) => {
      const row = rows(state, ctx)[state.cursor];
      return !row || row.other ? state : setModel(state, name, field, row.value);
    },
  };
}

/**
 * Selects `clone`: toggles the row at its path, moves the row that names its repo to the typed path and selects it,
 * or adds a selected row above "other" when no row names it.
 */
function selectRepo(state: SetupState, clone: Clone): SetupState {
  const known = state.repos.find((row) => sameRepo(row.fullName, clone.fullName));
  if (known) {
    const next =
      known.localPath === clone.localPath
        ? { ...known, on: !known.on }
        : { ...known, ...clone, exists: true, on: true };
    const repos = state.repos.map((row) => (row === known ? next : row));
    return { ...state, repos, typing: undefined };
  }
  const next = { ...state, repos: [...state.repos, { ...clone, exists: true, on: true }], typing: undefined };
  // The cursor stays on "other", which the new row pushed down.
  return { ...next, cursor: shown(next).length };
}

/** True when `row` matches `filter`: a case-insensitive substring of its name or path. */
const matches = (row: RepoOption, filter: string) =>
  `${row.fullName}\n${tildify(row.localPath)}`.toLowerCase().includes(filter.toLowerCase());

/**
 * The rows the repos step lists, as indices into `state.repos`: every row with no filter, else those matching it.
 * The cursor counts over these, with "other" at `shown.length`.
 */
const shown = (state: SetupState): number[] =>
  state.repos.flatMap((row, i) => (!state.filter || matches(row, state.filter) ? [i] : []));

/** Sets the filter, keeping the cursor on the highlighted row when it is still shown (or on "other"), else on the top. */
function setFilter(state: SetupState, filter: string | undefined, filtering: boolean): SetupState {
  const row = shown(state)[state.cursor];
  const next = { ...state, filter: filter || undefined, filtering };
  const list = shown(next);
  const at = row === undefined ? list.length : list.indexOf(row);
  return { ...next, cursor: at >= 0 ? at : 0 };
}

/**
 * Keys while the filter input is open: editing keys, the arrows and space still move and toggle on the narrowed list,
 * enter closes the input keeping the filter, and escape clears it. Every other key does nothing.
 */
function filtered(state: SetupState, key: string): SetupState {
  const text = state.filter ?? '';
  if (key === 'escape') return setFilter(state, undefined, false);
  if (key === 'enter') return { ...state, filtering: false };
  if (key === 'backspace') return setFilter(state, text.slice(0, -1), true);
  if (key === 'ctrl-u') return setFilter(state, '', true);
  if (key === 'up' || key === 'down') return move(state, key, shown(state).length + 1);
  if (key === 'space') {
    const row = state.repos[shown(state)[state.cursor]!];
    return row ? selectRepo(state, row) : state;
  }
  return key.length === 1 && key > ' ' ? setFilter(state, text + key, true) : state;
}

const REPOS_STEP: Step = {
  group: 'Repos',
  body: (state, ctx, paint, height) => {
    const listed = shown(state).map((i) => state.repos[i]!);
    const other = listed.length;
    const width = (text: (row: RepoOption) => string) => Math.max(0, ...listed.map((row) => text(row).length));
    const [nameW, pathW] = [width((row) => row.fullName), width((row) => tildify(row.localPath))];
    const rows = listed.map((row, i) => {
      const active = i === state.cursor;
      return [
        active ? paint(CYAN, '›') : ' ',
        row.on ? paint(GREEN, '■') : paint(DIM, '□'),
        paint(active ? BOLD : '', row.fullName.padEnd(nameW)),
        ` ${tildify(row.localPath).padEnd(pathW)}`,
        ` ${paint(DIM, triggerOf(row))}`,
        moved(row) ? ` ${paint(GREEN, 'moved')}` : row.exists ? '' : ` ${paint(YELLOW, missing(row))}`,
      ]
        .join(' ')
        .trimEnd();
    });
    const active = state.cursor === other;
    const label = state.typing === undefined ? 'other…' : `${state.typing}▏`;
    rows.push(`${active ? paint(CYAN, '›') : ' '} ${paint(DIM, ' ')} ${paint(active ? BOLD : '', label)}`);
    const found = ctx.disk.found.length;
    const intro =
      found > 0
        ? paint(DIM, `Found ${found} GitHub clones under ~. Each repo selected is reviewed on every PR.`)
        : paint(DIM, "No GitHub clone found under ~; pick other to type a clone's path.");
    // The filter line takes the blank line's place, so the list doesn't jump when it opens.
    const count = `${other} of ${state.repos.length} · ${state.repos.filter((row) => row.on).length} selected`;
    const filter = state.filtering
      ? `${paint(CYAN, '/')} ${state.filter ?? ''}▏ ${paint(DIM, count)}`
      : state.filter
        ? paint(DIM, `/ ${state.filter} · ${count}`)
        : '';
    return [
      'Which repos should review-relay watch?',
      intro,
      filter,
      ...windowed(rows, state.cursor, height - 3, paint),
    ];
  },
  // Starts on the first selected repo, which a long list of clones may otherwise scroll out of view.
  cursor: (state) =>
    Math.max(
      0,
      state.repos.findIndex((row) => row.on),
    ),
  hint: (state) => {
    if (state.typing !== undefined) return "type a clone's path · enter add it · esc back to the list";
    if (state.filtering) return 'type to filter · ↑↓ move · space select · enter keep filter · esc clear it';
    const act = state.cursor === shown(state).length ? 'enter type a path' : 'space select · enter next';
    return `↑↓ move · ${act} · / filter · ${state.filter ? 'esc clear filter' : 'q quit'}`;
  },
  onKey: (state, key, ctx) => {
    if (state.typing !== undefined) {
      return typed(state, key, (text) => {
        const dir = untildify(text);
        const clone = ctx.disk.at(dir);
        return clone ? selectRepo(state, clone) : { ...state, error: `no GitHub clone at ${tildify(dir)}` };
      });
    }
    if (state.filtering) return filtered(state, key);
    if (key === '/') return { ...state, filtering: true };
    // With a filter kept, escape clears it before it would quit.
    if (key === 'escape' && state.filter) return setFilter(state, undefined, false);
    const list = shown(state);
    const stepped = move(state, key, list.length + 1);
    if (stepped !== state) return stepped;
    const row = state.repos[list[state.cursor]!];
    if (!row) return key === 'enter' || key === 'right' ? { ...state, typing: '' } : state;
    return key === 'space' ? selectRepo(state, row) : state;
  },
  validate: (state) => (state.repos.some((row) => row.on) ? undefined : 'select at least one repo'),
};

const REVIEWERS_STEP: Step = {
  group: 'Reviewers',
  body: (state, ctx, paint, height) => {
    const found = HARNESS_NAMES.filter((name) => ctx.installed[name]).length;
    const modelText = (name: ReviewerId) => {
      const { model, effort } = state.models[name]!;
      return [model ?? 'default model', effort && `effort ${effort}`].filter(Boolean).join(' · ');
    };
    const product = (name: ReviewerId) => HARNESSES[ctx.harnessOf[name]!].product;
    const width = (text: (name: ReviewerId) => string) => Math.max(...ctx.options.map((n) => text(n).length));
    const [nameW, productW, modelW] = [width((n) => n), width(product), width(modelText)];
    const rows = ctx.options.map((name, i) => {
      const active = i === state.cursor;
      const harness = ctx.harnessOf[name]!;
      const row = [
        active ? paint(CYAN, '›') : ' ',
        state.selected.includes(name) ? paint(GREEN, '■') : paint(DIM, '□'),
        paint(active ? BOLD : '', name.padEnd(nameW)),
        ` ${product(name).padEnd(productW)}`,
        ` ${modelText(name).padEnd(modelW)}`,
        ctx.installed[harness] ? '' : ` ${paint(YELLOW, `${harness === name ? '' : `${harness} `}not found on PATH`)}`,
      ];
      return row.join(' ').trimEnd();
    });
    const intro =
      found > 0
        ? paint(
            DIM,
            `Found ${found} of ${HARNESS_NAMES.length} supported agent CLIs. Each one selected reviews every PR.`,
          )
        : `${paint(YELLOW, '!')} No supported agent CLI is on PATH. Install one, then run setup again.`;
    const footer = ctx.notFound.length > 0 ? ['', paint(DIM, `Not installed: ${ctx.notFound.join(', ')}`)] : [];
    return [
      'Which agents should review pull requests?',
      intro,
      '',
      ...windowed(rows, state.cursor, height - 3 - footer.length, paint),
      ...footer,
    ];
  },
  hint: () => '↑↓ move · space select · enter next · q quit',
  onKey: (state, key, ctx) => {
    const stepped = move(state, key, ctx.options.length);
    if (stepped !== state) return stepped;
    if (key !== 'space') return state;
    const name = ctx.options[state.cursor]!;
    const on = state.selected.includes(name);
    return { ...state, selected: ctx.options.filter((o) => (o === name ? !on : state.selected.includes(o))) };
  },
  validate: (state) => (state.selected.length > 0 ? undefined : 'select at least one reviewer'),
};

/**
 * The save step's lines: the warnings first, so they show before anything scrolls, then the repos, the reviewers and
 * their settings; all scroll together, so many warnings never push the key help off a short terminal.
 */
function saveRows(state: SetupState, ctx: SetupContext, paint: Paint): string[] {
  const reviewersChanged =
    ctx.raw && JSON.stringify(state.selected) !== JSON.stringify(ctx.raw.reviewers ?? DEFAULT_REVIEWERS);
  const after = state.selected.join(', ');
  const value = reviewersChanged ? `${ctx.current.join(', ') || 'none'} ${paint(DIM, '→')} ${after}` : after;
  const width = Math.max('reviewers'.length, ...state.selected.map((name) => name.length));
  const watched = state.repos.filter((row) => row.on);
  const dropped = ctx.repos.filter((row) => row.entry && !watched.some((w) => sameRepo(w.fullName, row.fullName)));
  const nameW = Math.max(0, ...[...watched, ...dropped].map((row) => row.fullName.length));
  const repoRows = [
    ...watched.map((row) =>
      [
        row.fullName.padEnd(nameW),
        `${moved(row) ? `${tildify(entryPath(row.entry!))} ${paint(DIM, '→')} ` : ''}${tildify(row.localPath)} · ${triggerOf(row)}`,
        !row.entry && paint(GREEN, 'new'),
      ]
        .filter(Boolean)
        .join('  '),
    ),
    ...dropped.map((row) => `${row.fullName.padEnd(nameW)}  ${paint(YELLOW, 'removed')}`),
  ].map((text, i) => `  ${paint(DIM, (i === 0 ? 'repos' : '').padEnd(width))}  ${text}`);
  const settings = (name: ReviewerId) =>
    modelKeys(ctx.harnessOf[name]!)
      .map((key) => {
        const show = (v: string | undefined) => v ?? `${HARNESSES[ctx.harnessOf[name]!].bins[0]}'s default`;
        const [was, now] = [ctx.models[name]![key], state.models[name]![key]];
        return `${key} ${was === now ? show(now) : `${show(was)} ${paint(DIM, '→')} ${show(now)}`}`;
      })
      .join(' · ');
  const warnings = [
    ...watched
      .filter((row) => !row.exists)
      .map(
        (row) => `${paint(YELLOW, '!')} ${row.fullName} has no clone at ${tildify(row.localPath)}, so its reviews fail`,
      ),
    ...state.selected
      .filter((name) => !ctx.installed[ctx.harnessOf[name]!])
      .map((name) => {
        const harness = ctx.harnessOf[name]!;
        const what = harness === name ? `${name} is` : `${name} runs ${harness}, which is`;
        return `${paint(YELLOW, '!')} ${what} not on PATH, so its reviews fail until it is installed`;
      }),
  ];
  // Routes are edited in the file only, so they are listed as they are, and saving keeps them.
  const routeRows = (Array.isArray(ctx.raw?.routes) ? ctx.raw.routes : []).map((entry: unknown, i: number) => {
    const route = plain(entry);
    const runs = route.skip === true ? 'skip' : [route.reviewers].flat().filter(Boolean).join(', ') || '?';
    return `  ${paint(DIM, (i === 0 ? 'routes' : '').padEnd(width))}  ${asText(route.name) ?? '?'} ${paint(DIM, '→')} ${runs}`;
  });
  return [
    ...(warnings.length > 0 ? [...warnings, ''] : []),
    ...repoRows,
    `  ${paint(DIM, 'reviewers'.padEnd(width))}  ${value}`,
    ...state.selected.map((name) => `  ${paint(DIM, name.padEnd(width))}  ${settings(name)}`),
    ...routeRows,
  ];
}

const SAVE_STEP: Step = {
  group: 'Save',
  body: (state, ctx, paint, height) => [
    !ctx.raw
      ? 'Create the config file with these settings?'
      : hasChanges(state, ctx)
        ? 'Save these changes?'
        : 'Nothing changed.',
    '',
    ...windowed(saveRows(state, ctx, paint), state.cursor, height - 2, paint),
  ],
  hint: (state, ctx) =>
    [`enter ${hasChanges(state, ctx) ? 'save' : 'exit'}`, '↑↓ scroll', '← back', 'q quit'].join(' · '),
  // The rows scroll like a list, around a cursor that isn't drawn.
  onKey: (state, key, ctx) => move(state, key, saveRows(state, ctx, (_, text) => text).length),
};

/** The repos and reviewers steps, a model and (where the CLI takes one) an effort step per selected reviewer, then save. */
const steps = (state: SetupState, ctx: SetupContext): Step[] => [
  REPOS_STEP,
  REVIEWERS_STEP,
  ...state.selected.flatMap((name) => {
    const harness = ctx.harnessOf[name]!;
    return modelKeys(harness).map((field) => modelStep(name, harness, field));
  }),
  SAVE_STEP,
];

/** Moves to step `index` with the row that step starts on highlighted. */
function goTo(state: SetupState, index: number, ctx: SetupContext): SetupState {
  const next: SetupState = {
    ...state,
    step: index,
    error: undefined,
    typing: undefined,
    filter: undefined,
    filtering: false,
  };
  return { ...next, cursor: steps(next, ctx)[index]!.cursor?.(next, ctx) ?? 0 };
}

/** Applies one key from `parseKeys`. Sets `done` when the user saves or quits. */
export function reduce(state: SetupState, key: string, ctx: SetupContext): SetupState {
  if (key === 'ctrl-c') return { ...state, done: 'cancel' };
  const list = steps(state, ctx);
  const step = list[state.step]!;
  // A key the step handles clears the last error, unless the step raises one of its own.
  const cleared = state.error === undefined ? state : { ...state, error: undefined };
  const own = step.onKey?.(cleared, key, ctx) ?? cleared;
  if (own !== cleared) return own;
  // A text input takes every other key as well, so q and the arrows can't act on the setup while typing.
  if (state.typing !== undefined || state.filtering) return state;
  if (key === 'q' || key === 'escape') return { ...state, done: 'cancel' };
  const last = state.step === list.length - 1;
  if (key === 'enter' || (key === 'right' && !last)) {
    const error = step.validate?.(state);
    if (error) return { ...state, error };
    const left = step.leave?.(state, ctx) ?? state;
    return last ? { ...left, done: 'save' } : goTo(left, state.step + 1, ctx);
  }
  if (key === 'left' || key === 'backspace') {
    return state.step === 0 ? { ...state, error: undefined } : goTo(state, state.step - 1, ctx);
  }
  return state;
}

/** `height` is the terminal's row count; the lists scroll when the frame would not fit. */
export function renderSetup(state: SetupState, ctx: SetupContext, color: boolean, height = Infinity): string[] {
  const paint: Paint = (code, text) => (color && code && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  const list = steps(state, ctx);
  const step = list[state.step]!;
  const pages = list.filter((s) => s.group === 'Models');
  const active = GROUPS.indexOf(step.group);
  const progress = GROUPS.map((group, i) => {
    const label = group === 'Models' && i === active ? `Models ${pages.indexOf(step) + 1}/${pages.length}` : group;
    return i < active
      ? paint(GREEN, `✔ ${label}`)
      : i === active
        ? paint(CYAN, `● ${label}`)
        : paint(DIM, `○ ${label}`);
  }).join(paint(DIM, ' ── '));
  const file = tildify(ctx.path) + (ctx.raw ? '' : ' (new file)');
  const head = ['', `${paint(BOLD, 'review-relay setup')}  ${paint(DIM, file)}`, '', progress, ''];
  const foot = [
    '',
    ...(state.error ? [`${paint(YELLOW, '!')} ${state.error}`, ''] : []),
    paint(DIM, step.hint(state, ctx)),
  ];
  const body = step.body(state, ctx, paint, height - head.length - foot.length);
  return [...head, ...body, ...foot].map((line) => (line ? `  ${line}` : line));
}

const KEY_NAMES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  // Sent instead when the terminal is left in application cursor mode.
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\r': 'enter',
  '\n': 'enter',
  ' ': 'space',
  '\x1b': 'escape',
  '\x03': 'ctrl-c',
  '\x15': 'ctrl-u',
  '\x7f': 'backspace',
  '\b': 'backspace',
};

/**
 * Splits raw-mode terminal input into key names (`up`, `enter`, `space`, ...) or the typed characters.
 * readline's keypress events would do this too, but they hold a lone Esc for 500ms before reporting it.
 */
export const parseKeys = (input: string): string[] =>
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences start with ESC
  (input.match(/\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-Z]|[\s\S]/g) ?? []).map((seq) => KEY_NAMES[seq] ?? seq);

const INLINE_WIDTH = 80;

/** Two-space JSON that keeps short arrays and objects of plain values on one line, the way config.example.json reads. */
export function formatJson(value: unknown, indent = '', lead = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? value.map((v) => ['', v])
    : Object.entries(value).map(([k, v]) => [`${JSON.stringify(k)}: `, v]);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) return open + close;
  if (indent && entries.every(([, v]) => v === null || typeof v !== 'object')) {
    const items = entries.map(([k, v]) => k + JSON.stringify(v)).join(', ');
    const line = isArray ? `[${items}]` : `{ ${items} }`;
    if (indent.length + lead + line.length < INLINE_WIDTH) return line;
  }
  const inner = `${indent}  `;
  const lines = entries.map(([k, v]) => inner + k + formatJson(v, inner, k.length));
  return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
}

async function readRawConfig(path: string): Promise<Record<string, any> | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  let raw: unknown;
  try {
    // JSON.parse names the problem; Bun's file.json() only says it failed.
    raw = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`, { cause: err });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  return raw as Record<string, any>;
}

/** Runs the steps on the terminal's alternate screen until the user saves or quits. */
function interact(ctx: SetupContext): Promise<SetupState> {
  const { stdin, stdout } = process;
  let state = initialState(ctx);
  // Home the cursor and clear each line's leftovers instead of the whole screen, so redraws don't flicker.
  const draw = () => stdout.write(`\x1b[H${renderSetup(state, ctx, true, stdout.rows).join('\x1b[K\n')}\x1b[K\x1b[J`);
  const restore = () => stdout.write('\x1b[?25h\x1b[?1049l');
  return new Promise((resolve, reject) => {
    // Leaves the alternate screen before settling, so whatever prints next (an error too) stays visible.
    const stop = (settle: () => void) => {
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      process.off('exit', restore);
      stdin.setRawMode(false);
      stdin.pause();
      restore();
      settle();
    };
    const guarded = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        stop(() => reject(err));
      }
    };
    const onData = (chunk: Buffer) =>
      guarded(() => {
        for (const key of parseKeys(String(chunk))) {
          state = reduce(state, key, ctx);
          if (state.done) return stop(() => resolve(state));
        }
        draw();
      });
    const onResize = () => guarded(draw);
    // Raw mode turns Ctrl+C into a key press, not SIGINT. The exit hook is a backstop for throws `guarded` misses.
    stdin.setRawMode(true);
    process.on('exit', restore);
    stdout.write('\x1b[?1049h\x1b[?25l');
    stdin.on('data', onData);
    stdin.resume();
    stdout.on('resize', onResize);
    onResize();
  });
}

/**
 * Interactive setup: pick the repos to watch, the reviewers, and their models, then write them into the config file
 * (created when missing).
 */
export async function setup(path: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('setup needs an interactive terminal');
  const raw = await readRawConfig(path);
  const disk: Disk = { found: discoverClones(), at: cloneAt, here: cloneAround(process.cwd()) };
  const ctx = setupContext(path, raw, (bin) => Bun.which(bin), disk);
  const result = await interact(ctx);
  if (result.done === 'cancel') return console.log('setup cancelled, nothing saved');
  if (!hasChanges(result, ctx)) return console.log(`nothing changed in ${tildify(path)}`);

  const models = nextModels(result, ctx);
  const next: Record<string, any> = { ...raw, reviewers: result.selected, repos: nextRepos(result) };
  // A file that never had `models` gains it only when a pick put something there.
  if (raw?.models !== undefined || Object.keys(models).length > 0) next.models = models;
  await Bun.write(path, `${formatJson(next)}\n`);
  const repos = next.repos.map((entry: Record<string, any>) => entry.fullName).join(', ');
  console.log(`\x1b[32m✔\x1b[0m saved repos (${repos}), reviewers (${result.selected.join(', ')}), and their models`);
  console.log(`  to ${tildify(path)}; if the daemon is running, apply with: scripts/relay restart`);
}
