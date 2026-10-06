/**
 * Raw-mode terminal plumbing shared by the interactive commands (`setup`, `tui`): key parsing, list windowing,
 * ANSI-aware clipping, and the alternate-screen loop that redraws a screen on every key, tick, and resize.
 */
import { visibleLength } from './ui.ts';

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
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[7~': 'home',
  '\x1b[8~': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\r': 'enter',
  '\t': 'tab',
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

type Paint = (code: string, text: string) => string;

/** The rows that fit in `room` lines, kept around the cursor, with markers for what scrolled out of view. */
export function windowed(rows: string[], cursor: number, room: number, paint: Paint): string[] {
  if (rows.length <= room) return rows;
  const size = Math.max(1, room - 2);
  const start = Math.min(Math.max(0, cursor - Math.floor(size / 2)), rows.length - size);
  const below = rows.length - start - size;
  return [
    paint('2', start > 0 ? `  ↑ ${start} more` : ''),
    ...rows.slice(start, start + size),
    paint('2', below > 0 ? `  ↓ ${below} more` : ''),
  ];
}

/**
 * The cursor after a movement key over `n` rows: up and down wrap, home/end and page keys clamp; undefined when
 * `key` isn't a movement.
 */
export function moved(cursor: number, key: string, n: number, page = 10): number | undefined {
  if (n === 0) return undefined;
  const last = n - 1;
  switch (key) {
    case 'up':
    case 'k':
      return (cursor + n - 1) % n;
    case 'down':
    case 'j':
      return (cursor + 1) % n;
    case 'home':
    case 'g':
      return 0;
    case 'end':
    case 'G':
      return last;
    case 'pageup':
      return Math.max(0, cursor - page);
    case 'pagedown':
      return Math.min(last, cursor + page);
    default:
      return undefined;
  }
}

// oxlint-disable-next-line no-control-regex
const SGR_AT = /^\x1b\[[\d;]*m/;

/** The first `width` visible characters of `line`, keeping its ANSI styling and closing it at the cut. */
export function clip(line: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let seen = 0;
  let styled = false;
  for (let i = 0; i < line.length;) {
    const sgr = SGR_AT.exec(line.slice(i));
    if (sgr) {
      out += sgr[0];
      styled = sgr[0] !== '\x1b[0m';
      i += sgr[0].length;
      continue;
    }
    if (seen === width) return out + (styled ? '\x1b[0m' : '');
    const ch = line.codePointAt(i)!;
    const text = String.fromCodePoint(ch);
    out += text;
    seen++;
    i += text.length;
  }
  return out;
}

export interface Screen {
  /** The frame to draw for a terminal of `height` rows and `width` columns. */
  render(height: number, width: number): string[];
  /** Applies one key; returns true when the screen is finished. */
  key(key: string): boolean;
  /** Called every `tickMs` while the screen is open, before a redraw. */
  tick?(): void;
  tickMs?: number;
}

/**
 * Runs `screen` on the terminal's alternate screen until `key` says it is finished. Redraws after every key, tick,
 * and resize; restores the terminal before settling, so whatever prints next (an error too) stays visible.
 */
/**
 * The escape-sequence string that draws `lines` on a `rows` × `cols` terminal. Every row is positioned explicitly,
 * and a row's leftovers are erased only when it is narrower than the terminal: after a full-width row the cursor
 * sits on the last column, where erase-line would blank that cell. Rows below the frame are cleared the same way.
 */
export function frame(lines: string[], rows: number, cols: number): string {
  const out = lines.slice(0, rows).map((line, i) => {
    const cut = clip(line, cols);
    return `\x1b[${i + 1};1H${cut}${visibleLength(cut) < cols ? '\x1b[K' : ''}`;
  });
  if (lines.length < rows) out.push(`\x1b[${lines.length + 1};1H\x1b[J`);
  return out.join('');
}

/**
 * How many colors the terminal takes: `COLORTERM` says so on most terminals; a few well-known ones are recognized
 * by name when it is unset. `FORCE_COLOR=3` asks for 24-bit color outright.
 */
export function colorDepth(env: NodeJS.ProcessEnv = process.env): 'truecolor' | 'basic' {
  if (env.FORCE_COLOR === '3') return 'truecolor';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/-direct$|truecolor|24bit/i.test(env.TERM ?? '')) return 'truecolor';
  if (/^(vscode|iTerm\.app|WezTerm|Hyper|ghostty|kitty|Alacritty|WarpTerminal|Tabby)$/i.test(env.TERM_PROGRAM ?? '')) {
    return 'truecolor';
  }
  // Windows Terminal doesn't set COLORTERM but does set a session id.
  if (env.WT_SESSION) return 'truecolor';
  return 'basic';
}

export function runScreen(screen: Screen): Promise<void> {
  const { stdin, stdout } = process;
  // Redraw in place instead of clearing the whole screen, so redraws don't flicker.
  const draw = () => {
    const [rows, cols] = [stdout.rows || 24, stdout.columns || 80];
    stdout.write(frame(screen.render(rows, cols), rows, cols));
  };
  const restore = () => stdout.write('\x1b[?25h\x1b[?1049l');
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (settle: () => void) => {
      if (timer) clearInterval(timer);
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
          if (screen.key(key)) return stop(resolve);
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
    if (screen.tick) {
      timer = setInterval(
        () =>
          guarded(() => {
            screen.tick!();
            draw();
          }),
        screen.tickMs ?? 1000,
      );
    }
    onResize();
  });
}

/** SGR parameters for a 24-bit color, `fg` or `bg`, from a `0xrrggbb` value. */
export const rgb = (hex: number, layer: 'fg' | 'bg' = 'fg'): string =>
  `${layer === 'fg' ? 38 : 48};2;${(hex >> 16) & 255};${(hex >> 8) & 255};${hex & 255}`;

/**
 * `line` clipped and padded to exactly `width` visible columns. With `base` (SGR parameters for the row's background
 * and text color), the row is painted edge to edge, and the base is restored after every reset inside the line, so a
 * colored cell can't punch a hole in the background.
 */
export function fill(line: string, width: number, base?: string): string {
  const cut = clip(line, width);
  const padded = cut + ' '.repeat(Math.max(0, width - visibleLength(cut)));
  if (!base) return padded;
  const on = `\x1b[${base}m`;
  return `${on}${padded.replaceAll('\x1b[0m', `\x1b[0m${on}`)}\x1b[0m`;
}
