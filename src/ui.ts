/**
 * Terminal styling shared by every command: one palette, one set of symbols, and the row and
 * section helpers that give `help`, `status`, and `info` the same shape.
 */
import { homedir } from 'node:os';

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const TONE_CODES: Record<Tone, string> = {
  success: ANSI.green,
  warning: ANSI.yellow,
  danger: ANSI.red,
  info: ANSI.blue,
  muted: ANSI.gray,
};

const TONE_ICONS: Record<Tone, string> = {
  success: '✓',
  warning: '!',
  danger: '✗',
  info: '•',
  muted: '○',
};

/** `NO_COLOR` wins, then `FORCE_COLOR`, then whether stdout is a terminal. */
export function supportsColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

export interface Styles {
  color: boolean;
  title: (s: string) => string;
  section: (s: string) => string;
  key: (s: string) => string;
  command: (s: string) => string;
  muted: (s: string) => string;
  bold: (s: string) => string;
  tone: (tone: Tone, s: string) => string;
  /** `✓ running`, `! stale`, `✗ failed`: an icon and a label in the tone's color. */
  badge: (tone: Tone, label: string) => string;
  /** A colored dot for list rows: `● repo`. */
  dot: (tone: Tone) => string;
  paint: (code: string, s: string) => string;
}

export function styles(color = supportsColor()): Styles {
  const paint = (code: string, s: string) => (color && s ? `${code}${s}${ANSI.reset}` : s);
  return {
    color,
    title: (s) => paint(ANSI.bold + ANSI.cyan, s),
    section: (s) => paint(ANSI.yellow, s),
    key: (s) => paint(ANSI.green, s),
    command: (s) => paint(ANSI.green, s),
    muted: (s) => paint(ANSI.gray, s),
    bold: (s) => paint(ANSI.bold, s),
    tone: (tone, s) => paint(TONE_CODES[tone], s),
    badge: (tone, label) => paint(TONE_CODES[tone], `${TONE_ICONS[tone]} ${label}`),
    dot: (tone) => paint(TONE_CODES[tone], '●'),
    paint,
  };
}

export const LABEL_WIDTH = 12;

/** `  label        value  detail`, with the label in the key color and the detail muted. */
export function row(st: Styles, label: string, value: string, detail?: string, width = LABEL_WIDTH): string {
  const tail = detail ? `  ${st.muted(detail)}` : '';
  return `  ${st.key(label.padEnd(width))}${value}${tail}`;
}

/** A yellow section heading preceded by a blank line. */
export const section = (st: Styles, title: string): string[] => ['', st.section(title)];

// oxlint-disable-next-line no-control-regex
const SGR = /\x1b\[[\d;]*m/g;

/** Visible length, ignoring ANSI sequences. */
export const visibleLength = (s: string): number => s.replace(SGR, '').length;

/** Pads by visible width so colored cells still line up. */
export const padVisible = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - visibleLength(s)));

/** Replaces the home folder with `~` for display. */
export const tildify = (path: string): string => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** `45s`, `3m 02s`, `2h 05m`, `1d 3h`. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** `a, b, c +2 more`. */
export function summarizeList(items: string[], max = 4): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

/** Drops ANSI escapes from untrusted text (log lines, reviewer errors) before printing it. */
export const sanitize = (s: string): string => s.replace(CSI, '').replace(OSC, '');
// oxlint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
