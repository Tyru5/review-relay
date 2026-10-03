import { basename } from 'node:path';
import { execOrThrow } from './exec.ts';

/** One changed file. A deleted file has its old path as `path`; a renamed one also has `oldPath`. */
export interface ChangedFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  testFiles: number;
  /** Changed files that tend to have wide impact: dependencies, CI, migrations, schemas, config. */
  sensitiveFiles: string[];
  /** Every changed file, which route conditions match against. */
  changed: ChangedFile[];
  /** The totals without lockfiles, which route size conditions use. */
  counted: { files: number; additions: number; deletions: number };
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const SENSITIVE_FILE =
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|Dockerfile|docker-compose[^/]*\.ya?ml|tsconfig[^/]*\.json)$|^\.github\/|(^|\/)migrations?\/|(^|\/)schema\.[a-z]+$|\.sql$|\.env/;

/** Lockfiles by name. Route size conditions leave them out, so a dependency bump counts as the code it changes. */
export const LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'deno.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'flake.lock',
  'Package.resolved',
  'pubspec.lock',
  'mix.lock',
]);

/** A changed file's paths: the old one too when it was renamed. */
export const pathsOf = (file: ChangedFile): string[] => (file.oldPath ? [file.oldPath, file.path] : [file.path]);

/**
 * Parses `git diff --numstat -z`: `added\tdeleted\tpath` per file, or for a rename `added\tdeleted\t` followed by the old
 * and new paths as fields of their own. Binary files report `-` for both counts.
 */
export function parseNumstat(numstat: string): DiffStats {
  const changed: ChangedFile[] = [];
  const fields = numstat.split('\0');
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const [added = '', deleted = '', ...rest] = fields[i]!.split('\t');
    let path = rest.join('\t');
    let oldPath: string | undefined;
    if (!path) {
      oldPath = fields[++i];
      path = fields[++i] ?? '';
    }
    if (!path) continue;
    changed.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
    });
  }
  const stats: DiffStats = {
    files: 0,
    additions: 0,
    deletions: 0,
    testFiles: 0,
    sensitiveFiles: [],
    changed,
    counted: { files: 0, additions: 0, deletions: 0 },
  };
  for (const file of changed) {
    const paths = pathsOf(file);
    stats.files += 1;
    stats.additions += file.additions;
    stats.deletions += file.deletions;
    if (paths.some((path) => TEST_FILE.test(path))) stats.testFiles += 1;
    if (paths.some((path) => SENSITIVE_FILE.test(path))) stats.sensitiveFiles.push(file.path);
    if (LOCKFILES.has(basename(file.path))) continue;
    stats.counted.files += 1;
    stats.counted.additions += file.additions;
    stats.counted.deletions += file.deletions;
  }
  return stats;
}

/** Stats for `base...head`, read in any checkout of the repo, the local clone included. */
export async function diffStats(dir: string, base: string, head = 'HEAD'): Promise<DiffStats> {
  // --find-renames makes renames show the same way whatever the user's diff.renames setting.
  return parseNumstat(
    await execOrThrow(['git', '-C', dir, 'diff', '--numstat', '-z', '--find-renames', `${base}...${head}`]),
  );
}

/** Linux caps one argv string at 128 KiB and some harnesses take the prompt as an argument, so stay well under. */
const PROMPT_DIFF_LIMIT = 60_000;

/** Commits and diff written into the prompt, for harnesses that run without a shell. */
export async function promptDiff(dir: string, baseRef: string, limit = PROMPT_DIFF_LIMIT): Promise<string> {
  const [log, diff] = await Promise.all([
    execOrThrow(['git', '-C', dir, 'log', '--format=%h %s', `${baseRef}..HEAD`]),
    execOrThrow(['git', '-C', dir, 'diff', `${baseRef}...HEAD`]),
  ]);
  const shown =
    diff.length > limit
      ? `${diff.slice(0, limit)}\n[diff cut at ${limit} of ${diff.length} characters; read the changed files for the rest]`
      : diff;
  return `Commits (git log ${baseRef}..HEAD):\n${log.trim()}\n\nDiff (git diff ${baseRef}...HEAD):\n${shown.trimEnd()}`;
}

export function describeStats(s: DiffStats): string {
  const parts = [`${s.files} files, +${s.additions} -${s.deletions}`, `${s.testFiles} test files changed`];
  if (s.sensitiveFiles.length) {
    const shown = s.sensitiveFiles.slice(0, 10).join(', ');
    parts.push(`wide-impact files: ${shown}${s.sensitiveFiles.length > 10 ? ', ...' : ''}`);
  }
  return parts.join('; ');
}
