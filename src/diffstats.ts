import { execOrThrow } from './exec.ts';

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  testFiles: number;
  /** Changed files that tend to have wide impact: dependencies, CI, migrations, schemas, config. */
  sensitiveFiles: string[];
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const SENSITIVE_FILE =
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|Dockerfile|docker-compose[^/]*\.ya?ml|tsconfig[^/]*\.json)$|^\.github\/|(^|\/)migrations?\/|(^|\/)schema\.[a-z]+$|\.sql$|\.env/;

export function parseNumstat(numstat: string): DiffStats {
  const stats: DiffStats = { files: 0, additions: 0, deletions: 0, testFiles: 0, sensitiveFiles: [] };
  for (const line of numstat.split('\n')) {
    const [add, del, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    stats.files += 1;
    // Binary files report "-" for both counts.
    stats.additions += Number(add) || 0;
    stats.deletions += Number(del) || 0;
    if (TEST_FILE.test(file)) stats.testFiles += 1;
    if (SENSITIVE_FILE.test(file)) stats.sensitiveFiles.push(file);
  }
  return stats;
}

export async function diffStats(dir: string, baseRef: string): Promise<DiffStats> {
  return parseNumstat(await execOrThrow(['git', '-C', dir, 'diff', '--numstat', `${baseRef}...HEAD`]));
}

export function describeStats(s: DiffStats): string {
  const parts = [`${s.files} files, +${s.additions} -${s.deletions}`, `${s.testFiles} test files changed`];
  if (s.sensitiveFiles.length) {
    const shown = s.sensitiveFiles.slice(0, 10).join(', ');
    parts.push(`wide-impact files: ${shown}${s.sensitiveFiles.length > 10 ? ', ...' : ''}`);
  }
  return parts.join('; ');
}
