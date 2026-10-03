import { homedir } from 'node:os';
import { DEFAULT_MODELS, DEFAULT_REVIEWERS, REVIEWERS, type ModelConfig } from './config.ts';
import { findBin, HARNESSES } from './reviewers/index.ts';
import type { ReviewerName } from './types.ts';

export interface SetupContext {
  path: string;
  /** The parsed config file, or undefined when saving creates it. */
  raw: Record<string, any> | undefined;
  /** `reviewers` as the file lists them, or the default when unset. */
  current: string[];
  /** Rows on the reviewers step: configured reviewers first, so saving keeps their order, then every installed one. */
  options: ReviewerName[];
  /** Executable found on PATH for each installed harness. */
  installed: Partial<Record<ReviewerName, string>>;
  /** Supported harnesses that are neither installed nor configured, named under the list. */
  notFound: ReviewerName[];
  models: Record<ReviewerName, ModelConfig>;
}

export interface SetupState {
  /** Index into STEPS. */
  step: number;
  /** Highlighted row on the reviewers step. */
  cursor: number;
  selected: ReviewerName[];
  /** Why the current step can't be left yet. */
  error?: string;
  done?: 'save' | 'cancel';
}

type Paint = (code: string, text: string) => string;

interface Step {
  title: string;
  /** `height` is how many lines the body may use before the terminal would scroll. */
  body(state: SetupState, ctx: SetupContext, paint: Paint, height: number): string[];
  /** Key help shown at the bottom. */
  hint(state: SetupState, ctx: SetupContext): string;
  /** Step-specific keys; returns `state` itself when the key does nothing here. */
  onKey?(state: SetupState, key: string, ctx: SetupContext): SetupState;
  /** Message that keeps the user on this step, or undefined to let them continue. */
  validate?(state: SetupState): string | undefined;
}

const BOLD = '1';
const DIM = '2';
const GREEN = '32';
const YELLOW = '33';
const CYAN = '36';

const isReviewer = (name: unknown): name is ReviewerName => REVIEWERS.includes(name as ReviewerName);

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

/** `raw` is the parsed config file, or undefined when there is none yet. `which` looks an executable up on PATH. */
export function setupContext(
  path: string,
  raw: Record<string, any> | undefined,
  which: (bin: string) => string | null,
): SetupContext {
  // A bare string (a slip for a one-item list) shows as that one reviewer.
  const current = [raw?.reviewers ?? DEFAULT_REVIEWERS].flat().map(String);
  const installed: SetupContext['installed'] = {};
  for (const name of REVIEWERS) {
    const bin = findBin(name, which);
    if (bin) installed[name] = bin;
  }
  const options = [...new Set([...current.filter(isReviewer), ...REVIEWERS.filter((name) => installed[name])])];
  const models = Object.fromEntries(
    REVIEWERS.map((name) => {
      const { model, effort } = { ...DEFAULT_MODELS[name], ...raw?.models?.[name] };
      return [name, { model: String(model ?? '') || undefined, effort: String(effort ?? '') || undefined }];
    }),
  ) as Record<ReviewerName, ModelConfig>;
  return {
    path,
    raw,
    current,
    options,
    installed,
    notFound: REVIEWERS.filter((name) => !options.includes(name)),
    models,
  };
}

/** Preselects the configured (or default) reviewers that are installed, else the first installed harness. */
export function initialState(ctx: SetupContext): SetupState {
  const usable = ctx.options.filter((name) => ctx.current.includes(name) && ctx.installed[name]);
  const first = ctx.options.find((name) => ctx.installed[name]);
  return { step: 0, cursor: 0, selected: usable.length > 0 ? usable : first ? [first] : [] };
}

/** Compares against the file's own value, so saving also repairs a malformed `reviewers`. */
export const hasChanges = (state: SetupState, ctx: SetupContext) =>
  !ctx.raw || JSON.stringify(state.selected) !== JSON.stringify(ctx.raw.reviewers ?? DEFAULT_REVIEWERS);

const STEPS: Step[] = [
  {
    title: 'Reviewers',
    body: (state, ctx, paint, height) => {
      const found = REVIEWERS.filter((name) => ctx.installed[name]).length;
      const modelText = (name: ReviewerName) => {
        const { model, effort } = ctx.models[name];
        return [model ?? 'default model', effort && `effort ${effort}`].filter(Boolean).join(' · ');
      };
      const width = (text: (name: ReviewerName) => string) => Math.max(...ctx.options.map((n) => text(n).length));
      const [nameW, productW, modelW] = [width((n) => n), width((n) => HARNESSES[n].product), width(modelText)];
      const rows = ctx.options.map((name, i) => {
        const active = i === state.cursor;
        const row = [
          active ? paint(CYAN, '›') : ' ',
          state.selected.includes(name) ? paint(GREEN, '■') : paint(DIM, '□'),
          paint(active ? BOLD : '', name.padEnd(nameW)),
          ` ${HARNESSES[name].product.padEnd(productW)}`,
          ` ${modelText(name).padEnd(modelW)}`,
          ctx.installed[name] ? '' : ` ${paint(YELLOW, 'not found on PATH')}`,
        ];
        return row.join(' ').trimEnd();
      });
      const intro =
        found > 0
          ? paint(
              DIM,
              `Found ${found} of ${REVIEWERS.length} supported agent CLIs. Each one selected reviews every PR.`,
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
      const n = ctx.options.length;
      if (key === 'up' || key === 'k') return { ...state, cursor: (state.cursor + n - 1) % n };
      if (key === 'down' || key === 'j') return { ...state, cursor: (state.cursor + 1) % n };
      if (key !== 'space') return state;
      const name = ctx.options[state.cursor]!;
      const on = state.selected.includes(name);
      return { ...state, selected: ctx.options.filter((o) => (o === name ? !on : state.selected.includes(o))) };
    },
    validate: (state) => (state.selected.length > 0 ? undefined : 'select at least one reviewer'),
  },
  {
    title: 'Save',
    body: (state, ctx, paint) => {
      const changed = hasChanges(state, ctx);
      const after = state.selected.join(', ');
      const value = ctx.raw && changed ? `${ctx.current.join(', ') || 'none'} ${paint(DIM, '→')} ${after}` : after;
      const warnings = state.selected
        .filter((name) => !ctx.installed[name])
        .map((name) => `${paint(YELLOW, '!')} ${name} is not on PATH, so its reviews fail until it is installed`);
      return [
        !ctx.raw ? 'Create the config file with these settings?' : changed ? 'Save these changes?' : 'Nothing changed.',
        '',
        `  ${paint(DIM, 'reviewers')}  ${value}`,
        ...(warnings.length > 0 ? ['', ...warnings] : []),
      ];
    },
    hint: (state, ctx) => `enter ${hasChanges(state, ctx) ? 'save' : 'exit'} · ← back · q quit`,
  },
];

/** Applies one key from `parseKeys`. Sets `done` when the user saves or quits. */
export function reduce(state: SetupState, key: string, ctx: SetupContext): SetupState {
  if (key === 'q' || key === 'escape' || key === 'ctrl-c') return { ...state, done: 'cancel' };
  const step = STEPS[state.step]!;
  const last = state.step === STEPS.length - 1;
  if (key === 'enter' || (key === 'right' && !last)) {
    const error = step.validate?.(state);
    if (error) return { ...state, error };
    return last ? { ...state, done: 'save' } : { ...state, step: state.step + 1 };
  }
  if (key === 'left' || key === 'backspace') return { ...state, step: Math.max(0, state.step - 1), error: undefined };
  const next = step.onKey?.(state, key, ctx) ?? state;
  return next === state ? state : { ...next, error: undefined };
}

/** `height` is the terminal's row count; the reviewer list scrolls when the frame would not fit. */
export function renderSetup(state: SetupState, ctx: SetupContext, color: boolean, height = Infinity): string[] {
  const paint: Paint = (code, text) => (color && code && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  const step = STEPS[state.step]!;
  const progress = STEPS.map((s, i) =>
    i < state.step
      ? paint(GREEN, `✔ ${s.title}`)
      : i === state.step
        ? paint(CYAN, `● ${s.title}`)
        : paint(DIM, `○ ${s.title}`),
  ).join(paint(DIM, ' ── '));
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

/** Interactive setup: pick reviewers, then write them into the config file (created when missing). */
export async function setup(path: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('setup needs an interactive terminal');
  const raw = await readRawConfig(path);
  const ctx = setupContext(path, raw, (bin) => Bun.which(bin));
  const result = await interact(ctx);
  if (result.done === 'cancel') return console.log('setup cancelled, nothing saved');
  if (!hasChanges(result, ctx)) return console.log(`nothing changed in ${tildify(path)}`);

  const next: Record<string, any> = { ...raw, reviewers: result.selected };
  await Bun.write(path, `${formatJson(next)}\n`);
  console.log(`\x1b[32m✔\x1b[0m saved reviewers (${result.selected.join(', ')}) to ${tildify(path)}`);
  console.log(
    Array.isArray(next.repos) && next.repos.length > 0
      ? '  if the daemon is running, apply with: scripts/relay restart'
      : '  next: add the repos to watch (see config.example.json)',
  );
}
