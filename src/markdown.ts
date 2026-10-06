/**
 * Renders the markdown review-relay posts (see `report.ts`) as styled terminal lines: headings, the scores table,
 * bullet lists, block quotes, code, and the inline bold, italic, code, and links, wrapped to a width. GitHub-flavored
 * HTML the comment uses (`<sub>`, `<br>`, `<details>`, `<summary>`) is folded in rather than shown. It covers what
 * the comment contains, not all of markdown.
 */
import { ANSI, visibleLength, type Styles } from './ui.ts';

interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  muted?: boolean;
}

const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';

/** Inline markup and tags in `src` as styled spans; `base` styles carry over an enclosing span (a muted `<sub>`). */
export function inline(src: string, base: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = [];
  let muted = base.muted;
  const push = (text: string, style: Omit<Span, 'text'> = {}) => {
    if (text) spans.push({ text, ...base, ...style, muted: muted || style.muted });
  };
  const pattern =
    /(`[^`]+`)|(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))|(?<![\w\\])_([^_]+?)_(?![\w])|(?<!\*)\*([^*]+?)\*(?!\*)|(<\/?[a-zA-Z][^>]*>)/g;
  let at = 0;
  for (const m of src.matchAll(pattern)) {
    push(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1]) push(m[1].slice(1, -1), { code: true });
    else if (m[3] !== undefined) for (const s of inline(m[3], { ...base, bold: true })) spans.push(s);
    else if (m[5] !== undefined) for (const s of inline(m[5], { ...base, link: true })) spans.push(s);
    else if (m[7] !== undefined) for (const s of inline(m[7], { ...base, italic: true })) spans.push(s);
    else if (m[8] !== undefined) for (const s of inline(m[8], { ...base, italic: true })) spans.push(s);
    else if (m[9]) {
      const tag = m[9].toLowerCase();
      if (tag === '<sub>' || tag === '<sup>') muted = true;
      else if (tag === '</sub>' || tag === '</sup>') muted = base.muted;
      else if (tag.startsWith('<br')) push('\n');
      // Other tags (<details>, <summary>, ...) are handled by the block pass or dropped.
    }
  }
  push(src.slice(at));
  return spans.map((s) => ({ ...s, text: s.text.replace(/\\([|*_`[\]])/g, '$1') }));
}

/** A span's text in its styles. */
function paintSpan(span: Span, st: Styles): string {
  if (!st.color) return span.text;
  if (span.code) return st.key(span.text);
  const codes = [
    span.bold && ANSI.bold,
    span.italic && ITALIC,
    span.link && UNDERLINE,
    span.muted && ANSI.gray,
    span.link && !span.muted && ANSI.blue,
  ]
    .filter(Boolean)
    .join('');
  return codes ? `${codes}${span.text}${ANSI.reset}` : span.text;
}

/**
 * Wraps `spans` to `width` columns, breaking at spaces; every line starts with `first` (the first) or `rest` (the
 * others), and a word longer than the room gets a line of its own.
 */
export function wrapSpans(spans: Span[], width: number, st: Styles, first = '', rest = ''): string[] {
  const lines: string[] = [];
  let line = first;
  let room = Math.max(1, width - visibleLength(first));
  let used = 0;
  let pendingSpace = false;
  const flush = () => {
    lines.push(line.trimEnd());
    line = rest;
    room = Math.max(1, width - visibleLength(rest));
    used = 0;
    pendingSpace = false;
  };
  for (const span of spans) {
    const parts = span.text.split(/(\n| +)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') {
        flush();
        continue;
      }
      if (/^ +$/.test(part)) {
        pendingSpace = used > 0;
        continue;
      }
      const need = part.length + (pendingSpace ? 1 : 0);
      if (used > 0 && used + need > room) flush();
      if (used > 0 && pendingSpace) {
        line += ' ';
        used++;
      }
      line += paintSpan({ ...span, text: part }, st);
      used += part.length;
      pendingSpace = false;
    }
  }
  if (used > 0 || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

const splitRow = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const isSeparator = (row: string) => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(row.trim());

/** A pipe table as aligned columns: the header bold, a rule under it, cells aligned as the separator row says. */
function table(rows: string[], width: number, st: Styles): string[] {
  const [head, sep, ...body] = rows;
  const aligns = splitRow(sep!).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  );
  const cells = [head!, ...body].map((row) => splitRow(row).map((cell) => inline(cell)));
  const cols = Math.max(...cells.map((r) => r.length));
  const text = (spans: Span[]) => spans.map((s) => s.text).join('');
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...cells.map((r) => text(r[c] ?? []).length)));
  // Shrink the widest columns until the table fits, so a narrow panel still shows every column.
  let total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
  while (total > width && Math.max(...widths) > 4) {
    widths[widths.indexOf(Math.max(...widths))]!--;
    total--;
  }
  const render = (row: Span[][], bold: boolean) =>
    row
      .map((spans, c) => {
        const styled = spans.map((s) => paintSpan({ ...s, bold: bold || s.bold }, st)).join('');
        const w = widths[c]!;
        let plain = text(spans);
        let out = styled;
        if (plain.length > w) {
          plain = `${plain.slice(0, w - 1)}…`;
          out = paintSpan({ text: plain, bold }, st);
        }
        const pad = w - plain.length;
        const left = aligns[c] === 'right' ? pad : aligns[c] === 'center' ? Math.floor(pad / 2) : 0;
        return ' '.repeat(left) + out + ' '.repeat(pad - left);
      })
      .join('  ')
      .trimEnd();
  const rule = st.muted(widths.map((w) => '─'.repeat(w)).join('  '));
  return [render(cells[0]!, true), rule, ...cells.slice(1).map((row) => render(row, false))];
}

export interface MarkdownDetails {
  /** Source line numbers, stable when an earlier section is collapsed or the terminal is resized. */
  collapsed?: readonly number[];
  selected?: number;
}

/** `md` as terminal lines no wider than `width`, with details expanded. */
export function renderMarkdown(md: string, width: number, st: Styles): string[] {
  return renderMarkdownView(md, width, st).lines;
}

/** Rendered lines and the visible disclosure headers, for keyboard navigation. */
export function renderMarkdownView(md: string, width: number, st: Styles, details: MarkdownDetails = {}) {
  const out: string[] = [];
  const sections: { id: number; line: number }[] = [];
  const blank = () => {
    if (out.length && out.at(-1) !== '') out.push('');
  };
  const src = md.split('\n');
  let i = 0;
  while (i < src.length) {
    const raw = src[i]!;
    const line = raw.trim();
    if (!line) {
      blank();
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const end = src.findIndex((l, j) => j > i && l.trim().startsWith('```'));
      const stop = end === -1 ? src.length : end;
      blank();
      for (const code of src.slice(i + 1, stop)) out.push(`  ${st.muted(code)}`);
      blank();
      i = stop + 1;
      continue;
    }
    if (line.startsWith('|') && i + 1 < src.length && isSeparator(src[i + 1]!)) {
      let end = i + 2;
      while (end < src.length && src[end]!.trim().startsWith('|')) end++;
      blank();
      out.push(...table(src.slice(i, end), width, st));
      blank();
      i = end;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blank();
      const text = inline(heading[2]!);
      const painted = text.map((s) => paintSpan({ ...s, bold: true }, st)).join('');
      out.push(heading[1]!.length <= 2 ? (st.color ? st.title(text.map((s) => s.text).join('')) : painted) : painted);
      blank();
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blank();
      out.push(st.muted('─'.repeat(Math.min(width, 40))));
      blank();
      i++;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    // The summary's source line identifies it independently of wrapping and hidden content.
    const summary = /<summary>(.*?)<\/summary>/i.exec(line);
    if (summary) {
      blank();
      const collapsed = details.collapsed?.includes(i);
      const selected = details.selected === i;
      sections.push({ id: i, line: out.length });
      const lead = ' '.repeat(indent);
      const label = `${selected ? '› ' : ''}${collapsed ? '▸' : '▾'} ${summary[1]}`;
      out.push(...wrapSpans(inline(label, { muted: !selected, bold: selected }), width, st, lead, lead));
      i++;
      if (collapsed) {
        let depth = 1;
        let fenced = false;
        // Count nested wrappers, but not examples inside code fences.
        while (i < src.length && depth > 0) {
          const next = src[i++]!.trim();
          if (next.startsWith('```')) fenced = !fenced;
          if (fenced) continue;
          for (const tag of next.matchAll(/<\/?details(?:\s[^>]*)?>/gi)) {
            depth += tag[0].startsWith('</') ? -1 : 1;
          }
        }
        blank();
      }
      continue;
    }
    if (/^<\/?details(?:\s[^>]*)?>$/i.test(line)) {
      blank();
      i++;
      continue;
    }
    const bullet = /^([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const mark = /\d/.test(bullet[1]!) ? `${bullet[1]} ` : '• ';
      const lead = ' '.repeat(indent);
      out.push(
        ...wrapSpans(inline(bullet[2]!), width, st, `${lead}${st.muted(mark)}`, `${lead}${' '.repeat(mark.length)}`),
      );
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const quote = line.replace(/^>\s?/, '');
      const bar = `${st.tone('warning', '▎')} `;
      out.push(...wrapSpans(inline(quote, { italic: true }), width, st, bar, bar));
      i++;
      continue;
    }
    // A paragraph: consecutive plain lines joined, as GitHub joins them.
    const para = [line];
    while (i + 1 < src.length) {
      const next = src[i + 1]!.trim();
      if (!next || /^([-*+]|\d+\.)\s|^#|^>|^\||^```|^<\/?details|<summary>/.test(next)) break;
      para.push(next);
      i++;
    }
    const lead = ' '.repeat(indent);
    out.push(...wrapSpans(inline(para.join(' ')), width, st, lead, lead));
    i++;
  }
  while (out.length && out.at(-1) === '') out.pop();
  return { lines: out, sections };
}
