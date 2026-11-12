/**
 * Findings as GitHub review comments on the lines they name. GitHub rejects a whole review when one comment names a
 * line outside the PR's diff, so only findings on added lines are commented on; the rest stay in the summary comment.
 */
import { execOrThrow } from './exec.ts';
import type { TrackedFinding } from './lifecycle.ts';
import { badge } from './report.ts';
import { DIMENSION_NAMES } from './verdict.ts';

/** Ends every inline comment, so a later review finds the ones review-relay posted. */
export const INLINE_MARKER = '<!-- review-relay:finding -->';

/** One comment in a `POST /pulls/{n}/reviews` body. A multi-line comment covers `start_line` through `line`. */
export interface InlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

/** A review comment review-relay posted earlier, as GitHub reports it. */
export interface PostedComment {
  path: string;
  original_line: number | null;
  original_commit_id: string;
}

/** Strips a/ or b/ and the tab git adds after a path with spaces; null for `/dev/null`, a deleted file's new side. */
const diffPath = (raw: string, prefix: string): string | null => {
  const path = raw.replace(/\t$/, '');
  if (path === '/dev/null') return null;
  // git quotes paths with quotes, backslashes, or control characters; JSON reads its escapes for the common ones.
  if (path.startsWith('"')) {
    try {
      const unquoted = JSON.parse(path) as string;
      return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
    } catch {
      return null;
    }
  }
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

/**
 * The added lines on the new side of each file, from `git diff -U0` with `a/` and `b/` prefixes: with no context, a
 * hunk's new side `+start,count` is exactly its added lines.
 */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = diffPath(line.slice(4), 'b/');
      lines = undefined;
      if (path === null) continue;
      lines = added.get(path) ?? new Set();
      added.set(path, lines);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !lines) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return added;
}

/** Added lines per file in `base...head`, read in any checkout of the repo, the local clone included. */
export async function addedLines(dir: string, base: string, head: string): Promise<Map<string, Set<number>>> {
  // Prefixes, renames, and colors pinned, whatever the user's diff settings say.
  return parseAddedLines(
    await execOrThrow([
      'git',
      '-C',
      dir,
      '-c',
      'core.quotePath=false',
      'diff',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      `${base}...${head}`,
    ]),
  );
}

/** A fence longer than any run of backticks in the text, so a replacement holding a code fence can't close it. */
const fence = (text: string) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * The comments for this review's new findings on added lines. An `open` finding was commented on when it was new. A
 * finding whose whole range is added lines gets a multi-line comment, and with a replacement, a suggestion block;
 * otherwise it comments on its first line alone, without one, since a suggestion replaces exactly the commented lines.
 */
export function planInline(
  findings: TrackedFinding[],
  added: Map<string, Set<number>>,
  labels: Map<string, string>,
): InlineComment[] {
  const comments: InlineComment[] = [];
  for (const f of findings) {
    if (f.status === 'open' || !f.file || f.line === null) continue;
    const lines = added.get(f.file);
    if (!lines?.has(f.line)) continue;
    const end = f.endLine ?? f.line;
    let whole = true;
    for (let n = f.line; n <= end; n++) if (!lines.has(n)) whole = false;
    const range = whole && end > f.line;
    const who = [f.reviewers.map((id) => labels.get(id) ?? id).join(', '), f.dimension && DIMENSION_NAMES[f.dimension]]
      .filter(Boolean)
      .join(' · ');
    const body = [
      `${badge(f)} ${f.title}`,
      `<sub>${who}</sub>`,
      '',
      f.detail,
      '',
      `**Suggested fix:** ${f.suggestion}`,
    ];
    if (whole && f.replacement !== undefined) {
      // A model often ends the text with a newline, which GitHub would apply as an extra blank line.
      const text = f.replacement.replace(/\n$/, '');
      const marks = fence(text);
      body.push('', `${marks}suggestion`, text, marks);
    }
    body.push('', INLINE_MARKER);
    comments.push({
      path: f.file,
      line: range ? end : f.line,
      side: 'RIGHT',
      ...(range ? { start_line: f.line, start_side: 'RIGHT' as const } : {}),
      body: body.join('\n'),
    });
  }
  return comments;
}

/**
 * The planned comments review-relay hasn't already posted on this commit: a mention or `run` re-reviewing a commit
 * would otherwise comment on the same spots again. Same path and a line within 3 count as the same spot.
 */
export const unposted = (planned: InlineComment[], posted: PostedComment[], headSha: string) =>
  planned.filter(
    (c) =>
      !posted.some(
        (p) =>
          p.original_commit_id === headSha &&
          p.path === c.path &&
          p.original_line !== null &&
          Math.abs(p.original_line - c.line) <= 3,
      ),
  );
