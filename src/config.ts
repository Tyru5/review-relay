import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReviewerName, TriggerMode } from './types.ts';

export interface GithubTriggerConfig {
  /** Also review on `pull_request.synchronize` (new commits). */
  onPush: boolean;
  /** Comment text that requests a review, e.g. `@review-relay`. */
  mention: string;
}

export interface RepoConfig {
  fullName: string;
  localPath: string;
  trigger: TriggerMode;
  postToPr: boolean;
  github: GithubTriggerConfig;
}

export interface Config {
  port: number;
  /** How long `auto` mode waits for Greptile after a GitHub PR event before running anyway. */
  graceMs: number;
  /** Per-reviewer timeout. */
  timeoutMs: number;
  reviewers: ReviewerName[];
  dataDir: string;
  repos: RepoConfig[];
}

export const DEFAULT_DATA_DIR = join(homedir(), '.review-relay');

export const defaultConfigPath = () =>
  process.env.REVIEW_RELAY_CONFIG ?? join(DEFAULT_DATA_DIR, 'config.json');

const TRIGGERS: TriggerMode[] = ['auto', 'greptile', 'github'];
const REVIEWERS: ReviewerName[] = ['codex', 'claude'];

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const c = raw as Record<string, any>;
  if (!Array.isArray(c.repos) || c.repos.length === 0) throw new Error('config.repos must list at least one repo');

  const reviewers: ReviewerName[] = c.reviewers ?? REVIEWERS;
  for (const r of reviewers) {
    if (!REVIEWERS.includes(r)) throw new Error(`unknown reviewer "${r}" (expected ${REVIEWERS.join(', ')})`);
  }

  const repos = c.repos.map((r: Record<string, any>, i: number): RepoConfig => {
    if (typeof r.fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.fullName)) {
      throw new Error(`repos[${i}].fullName must look like "owner/name"`);
    }
    if (typeof r.localPath !== 'string') throw new Error(`repos[${i}].localPath is required`);
    const trigger: TriggerMode = r.trigger ?? 'auto';
    if (!TRIGGERS.includes(trigger)) throw new Error(`repos[${i}].trigger must be one of ${TRIGGERS.join(', ')}`);
    return {
      fullName: r.fullName,
      localPath: resolve(r.localPath.replace(/^~(?=\/|$)/, homedir())),
      trigger,
      postToPr: r.postToPr ?? false,
      github: { onPush: r.github?.onPush ?? false, mention: r.github?.mention ?? '@review-relay' },
    };
  });

  return {
    port: c.port ?? 9988,
    graceMs: c.graceMs ?? 120_000,
    timeoutMs: c.timeoutMs ?? 30 * 60_000,
    reviewers,
    dataDir: c.dataDir ? resolve(String(c.dataDir).replace(/^~(?=\/|$)/, homedir())) : DEFAULT_DATA_DIR,
    repos,
  };
}

export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config at ${path} (copy config.example.json there, or set REVIEW_RELAY_CONFIG)`);
  }
  return parseConfig(await file.json());
}

export const findRepo = (config: Config, fullName: string | undefined) =>
  config.repos.find((r) => r.fullName.toLowerCase() === fullName?.toLowerCase());
