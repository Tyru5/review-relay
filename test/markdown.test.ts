import { describe, expect, test } from 'bun:test';
import { inline, renderMarkdown, wrapSpans } from '../src/markdown.ts';
import { styles, visibleLength } from '../src/ui.ts';

const plain = styles(false);
const color = styles(true);
const render = (md: string, width = 80) => renderMarkdown(md, width, plain);

/** The shape of a posted comment, as `report.ts` builds it. */
const COMMENT = `## review-relay: Confidence 4/5
<sub>Commit \`3d3adea3\` · pull_request opened · 3 files, +7 -6 · lowest of: Codex 4/5, Claude 5/5</sub><br>
<sub>Route \`risky\` (touches CI) · Codex: gpt-6-astra, high</sub>

**Codex:** Releases the CLI by bumping its version. _No introduced defects; the test suite lacks a release smoke check._

| | Codex | Claude |
|---|:-:|:-:|
| **Overall** | **4/5** | **5/5** |
| Correctness | 5 | 5 |
| Standards (repo + industry) | 5 | 5 |

### Findings (1)

- **Minor** [\`.github/workflows/ci.yml:39\`](https://github.com/acme/app/blob/abc/.github/workflows/ci.yml#L39): Publish not gated on CI \\| really _(Claude)_
  <details><summary>Details</summary>

  The release PR is opened by a bot token, so pull_request workflows never start and the merge publishes with zero checks run against it.

  **Suggested fix:** Pass an app token to the action.

  </details>

<details><summary>Dimension notes</summary>

**Codex**

- Correctness (5/5): Manifest and changelog agree.

</details>

> Gemini review failed: timed out after 1800s

<sub>Scores are 1-5 merge confidence.</sub>`;

describe('inline', () => {
  test('splits bold, italic, code, links, and GitHub tags into styled spans', () => {
    expect(inline('a **b** _c_ `d` [e](http://x) *f* g')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e', link: true },
      { text: ' ' },
      { text: 'f', italic: true },
      { text: ' g' },
    ]);
    // Styles nest; <sub> mutes what follows it; <br> breaks the line; escapes are unescaped.
    expect(inline('**x _y_** <sub>z `w`</sub><br>after \\| pipe')).toEqual([
      { text: 'x ', bold: true },
      { text: 'y', bold: true, italic: true },
      { text: ' ' },
      { text: 'z ', muted: true },
      { text: 'w', code: true, muted: true },
      { text: '\n', muted: undefined },
      { text: 'after | pipe', muted: undefined },
    ]);
    // Underscores inside identifiers are not italics.
    expect(inline('GITHUB_TOKEN and snake_case_name')).toEqual([{ text: 'GITHUB_TOKEN and snake_case_name' }]);
    // Tags themselves vanish; the block pass gives <summary> its meaning.
    expect(inline('<details><summary>Details</summary>')).toEqual([{ text: 'Details' }]);
  });
});

describe('wrapSpans', () => {
  test('breaks at spaces to the width with a hanging indent and keeps styles per word', () => {
    const spans = inline('one **two three** four five six');
    expect(wrapSpans(spans, 12, plain, '• ', '  ')).toEqual(['• one two', '  three four', '  five six']);
    const colored = wrapSpans(spans, 12, color, '• ', '  ');
    expect(colored[0]).toBe('• one \x1b[1mtwo\x1b[0m');
    expect(colored[1]).toBe('  \x1b[1mthree\x1b[0m four');
    for (const line of colored) expect(visibleLength(line)).toBeLessThanOrEqual(12);
    // A word longer than the room takes its own line rather than vanishing.
    expect(wrapSpans(inline('a verylongwordthatdoesnotfit b'), 10, plain)).toEqual([
      'a',
      'verylongwordthatdoesnotfit',
      'b',
    ]);
    expect(wrapSpans(inline('x<br>y'), 10, plain)).toEqual(['x', 'y']);
    expect(wrapSpans([], 10, plain, '> ')).toEqual(['>']);
  });
});

describe('renderMarkdown', () => {
  test('renders the posted comment: headings, sub lines, table, findings list, details, quote', () => {
    const lines = render(COMMENT, 90);
    const text = lines.join('\n');
    expect(lines[0]).toBe('review-relay: Confidence 4/5');
    expect(lines[1]).toBe('');
    // <sub> lines keep their text; <br> ends the line.
    expect(lines[2]).toBe('Commit 3d3adea3 · pull_request opened · 3 files, +7 -6 · lowest of: Codex 4/5, Claude 5/5');
    expect(lines[3]).toBe('Route risky (touches CI) · Codex: gpt-6-astra, high');
    expect(text).toContain(
      'Codex: Releases the CLI by bumping its version. No introduced defects; the test suite\nlacks a release smoke check.',
    );
    // The table aligns its columns and centers the scores.
    expect(text).toContain('                             Codex  Claude');
    expect(text).toMatch(/───+ {2}─────  ──────\n/);
    expect(text).toContain('Overall                       4/5    5/5');
    expect(text).toContain('Correctness                    5      5');
    expect(text).toContain('Standards (repo + industry)    5      5');
    expect(text).toContain('Findings (1)');
    // Links show their text, the escaped pipe is literal, and nested details show expanded under a label.
    expect(text).toContain('• Minor .github/workflows/ci.yml:39: Publish not gated on CI | really (Claude)');
    expect(text).not.toContain('https://');
    expect(text).toContain('  ▸ Details');
    expect(text).toContain('  The release PR is opened by a bot token, so pull_request workflows never start and the');
    expect(text).toContain('  merge publishes with zero checks run against it.');
    expect(text).toContain('  Suggested fix: Pass an app token to the action.');
    expect(text).not.toContain('<details>');
    expect(text).not.toContain('</details>');
    expect(text).toContain('▸ Dimension notes');
    expect(text).toContain('• Correctness (5/5): Manifest and changelog agree.');
    expect(text).toContain('▎ Gemini review failed: timed out after 1800s');
    expect(lines.at(-1)).toBe('Scores are 1-5 merge confidence.');
    // No run of blank lines, nothing wider than asked.
    expect(text).not.toContain('\n\n\n');
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(90);
  });

  test('in color, headings take the title style, code the key color, sub text gray, and links underline', () => {
    const lines = renderMarkdown(COMMENT, 90, color);
    expect(lines[0]).toBe(color.title('review-relay: Confidence 4/5'));
    expect(lines[2]).toContain(`\x1b[90mCommit\x1b[0m`);
    expect(lines[2]).toContain(color.key('3d3adea3'));
    expect(lines.join('\n')).toContain('\x1b[1mOverall\x1b[0m');
    // Code inside a link renders as code.
    expect(lines.join('\n')).toContain(color.key('.github/workflows/ci.yml:39'));
    expect(lines.join('\n')).toContain('\x1b[3mNo\x1b[0m');
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(90);
  });

  test('narrows a wide table to fit and marks the cut cells', () => {
    const md = '| Dimension | Codex |\n|---|:-:|\n| Standards (repo + industry) | 5 |';
    const lines = render(md, 24);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(24);
    expect(lines[2]).toMatch(/^Standards \(repo …\s+5$/);
  });

  test('handles code fences, rules, numbered lists, nested bullets, and joined paragraph lines', () => {
    const md = [
      'Line one',
      'line two',
      '',
      '```',
      'const x = 1;',
      '```',
      '---',
      '1. first',
      '2. second',
      '  - nested **bold**',
      '',
      '#### Small',
    ].join('\n');
    expect(render(md, 40)).toEqual([
      'Line one line two',
      '',
      '  const x = 1;',
      '',
      '─'.repeat(40),
      '',
      '1. first',
      '2. second',
      '  • nested bold',
      '',
      'Small',
    ]);
    expect(render('')).toEqual([]);
    expect(render('\n\n')).toEqual([]);
  });
});
