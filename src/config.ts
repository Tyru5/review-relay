import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARNESS_NAMES, HARNESSES, isHarness } from './reviewers/index.ts';
import { parseRoutes, type Route } from './routes.ts';
import type { HarnessName, ReviewerId, TriggerMode } from './types.ts';

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
  /** PR author logins to review, normalized by `normalizeLogin`; empty reviews every author. */
  authors: string[];
}

/** Lowercases a login and writes `gh`'s `app/<slug>` bot form as GitHub's `<slug>[bot]`. */
export const normalizeLogin = (login: string) =>
  login
    .trim()
    .toLowerCase()
    .replace(/^app\/(.+)$/, '$1[bot]');

export interface ModelConfig {
  /** Unset uses the CLI's own default model. */
  model?: string;
  /** Reasoning effort, for CLIs that take one (claude: low..max, codex: minimal..ultra). */
  effort?: string;
  /** Model provider, for CLIs that take it apart from the model (hermes). */
  provider?: string;
}

/** A reviewer as reviews run it: the CLI, its name in the PR comment, and the model settings. */
export interface ReviewerEntry extends ModelConfig {
  harness: HarnessName;
  label: string;
}

export const THEMES = ['dark', 'light', 'terminal'] as const;
export type ThemeName = (typeof THEMES)[number];

export interface Config {
  port: number;
  /** TUI colors; terminal inherits the terminal's configured palette. Defaults to dark. */
  theme?: ThemeName;
  /** How long `auto` mode waits for Greptile or CodeRabbit after a GitHub PR event before running anyway. */
  graceMs: number;
  /** Per-reviewer timeout. */
  timeoutMs: number;
  /** Reviews that run at once; each runs all of its reviewers. Later ones queue. */
  maxConcurrent: number;
  /** Ids of the reviewers that review every PR. */
  reviewers: ReviewerId[];
  /** Every reviewer by id: each CLI under its own name, plus the file's custom entries. */
  models: Record<ReviewerId, ReviewerEntry>;
  /** Checked from the top; the first that matches a PR decides its review, else `reviewers` runs. */
  routes: Route[];
  dataDir: string;
  repos: RepoConfig[];
}

export const DEFAULT_DATA_DIR = join(homedir(), '.review-relay');

export const defaultConfigPath = () => process.env.REVIEW_RELAY_CONFIG ?? join(DEFAULT_DATA_DIR, 'config.json');

/** Reviews at once by default; each spawns every reviewer it runs, so a burst of PRs would otherwise run them all. */
export const DEFAULT_MAX_CONCURRENT = 2;

/** Reviewers when the config lists none. */
export const DEFAULT_REVIEWERS: ReviewerId[] = ['codex', 'claude'];

/** Each CLI's settings when its entry sets none; unset ones fall back to the CLI's own default. */
export const DEFAULT_MODELS = Object.fromEntries(
  HARNESS_NAMES.map((name) => [name, { ...HARNESSES[name].defaults }]),
) as Record<HarnessName, ModelConfig>;

/** A custom reviewer id; ids become report file names and status columns. */
export const REVIEWER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const ENTRY_FIELDS = ['harness', 'model', 'effort', 'provider', 'label'];

const TRIGGERS: TriggerMode[] = ['auto', 'greptile', 'coderabbit', 'github'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Unset settings fall back to the CLI's defaults, never to another entry. */
function resolveEntry(id: ReviewerId, harness: HarnessName, settings: Record<string, string>): ReviewerEntry {
  const entry: ReviewerEntry = { harness, label: settings.label ?? (id === harness ? HARNESSES[harness].label : id) };
  const model = settings.model ?? DEFAULT_MODELS[harness].model;
  const effort = settings.effort ?? DEFAULT_MODELS[harness].effort;
  if (model) entry.model = model;
  if (effort) entry.effort = effort;
  if (settings.provider) entry.provider = settings.provider;
  return entry;
}

/**
 * One entry per reviewer id. A custom entry (one with `harness`) is new, so its mistakes are errors. The shapes older
 * configs use keep loading: their mistakes go to `warn`, and the setting is ignored as it always was.
 */
function parseModels(raw: unknown, warn: (message: string) => void): Record<ReviewerId, ReviewerEntry> {
  const entries: Record<ReviewerId, ReviewerEntry> = {};
  for (const name of HARNESS_NAMES) entries[name] = resolveEntry(name, name, {});
  if (raw === undefined) return entries;
  if (!isObject(raw)) {
    warn('models is not an object; ignored');
    return entries;
  }
  for (const [id, value] of Object.entries(raw)) {
    const cli = isHarness(id);
    if (!isObject(value) || (!cli && value.harness === undefined)) {
      warn(
        cli ? `models.${id} is not an object; ignored` : `models.${id} is not a CLI name and has no harness; ignored`,
      );
      continue;
    }
    if (value.harness !== undefined && !isHarness(value.harness)) {
      throw new Error(`models.${id}.harness must be one of ${HARNESS_NAMES.join(', ')}`);
    }
    if (cli && value.harness !== undefined && value.harness !== id) {
      throw new Error(`models.${id}.harness must be "${id}"; a CLI name always runs that CLI`);
    }
    if (!cli && !REVIEWER_ID.test(id)) {
      throw new Error(`models.${id}: custom ids use lowercase letters, digits, and dashes, up to 32 characters`);
    }
    const harness = cli ? id : (value.harness as HarnessName);
    // Mistakes in a custom entry stop the load; in a CLI-named entry, which older configs have, they warn.
    const reject = (message: string) => {
      if (!cli) throw new Error(message);
      warn(`${message}; ignored`);
    };
    const settings: Record<string, string> = {};
    for (const [key, setting] of Object.entries(value)) {
      if (key === 'harness') continue;
      if (!ENTRY_FIELDS.includes(key)) {
        reject(`models.${id}.${key} is not a setting (expected ${ENTRY_FIELDS.join(', ')})`);
        continue;
      }
      if (typeof setting !== 'string' || !setting) throw new Error(`models.${id}.${key} must be a non-empty string`);
      if (key === 'effort' && !HARNESSES[harness].choices.effort) {
        reject(`models.${id}.effort: ${harness} has no effort setting`);
        continue;
      }
      if (key === 'provider' && harness !== 'hermes') {
        reject(`models.${id}.provider: only hermes takes a provider`);
        continue;
      }
      settings[key] = setting;
    }
    entries[id] = resolveEntry(id, harness, settings);
  }
  return entries;
}

/** The reviewers a PR gets when no route matches: ids with an entry, each once. */
function parseReviewers(
  raw: unknown,
  models: Record<ReviewerId, ReviewerEntry>,
  file: unknown,
  warn: (message: string) => void,
): ReviewerId[] {
  const listed = raw ?? DEFAULT_REVIEWERS;
  if (!Array.isArray(listed)) throw new Error('reviewers must be a list of reviewer ids');
  if (listed.length === 0) throw new Error('reviewers must name at least one reviewer');
  const ids: ReviewerId[] = [];
  for (const id of listed) {
    if (typeof id !== 'string' || !Object.hasOwn(models, id)) {
      const named = typeof id === 'string' && isObject(file) && Object.hasOwn(file, id);
      throw new Error(
        named
          ? `unknown reviewer "${id}": models.${id} needs a harness naming its CLI`
          : `unknown reviewer ${JSON.stringify(id)} (expected a CLI name, ${HARNESS_NAMES.join(', ')}, or a models key with a harness)`,
      );
    }
    if (ids.includes(id)) {
      warn(`reviewers lists "${id}" twice; it runs once`);
      continue;
    }
    ids.push(id);
  }
  return ids;
}

/** Reviewers that can run, in `reviewers` or a route, need labels that tell them apart in the PR comment. */
export function checkLabels(ids: ReviewerId[], models: Record<ReviewerId, ReviewerEntry>) {
  const byLabel = new Map<string, ReviewerId>();
  for (const id of new Set(ids)) {
    const { label } = models[id]!;
    const other = byLabel.get(label.toLowerCase());
    if (other)
      throw new Error(`reviewers "${other}" and "${id}" share the label "${label}"; set a different label on one`);
    byLabel.set(label.toLowerCase(), id);
  }
}

/** Validates and fills in defaults. Problems the file has always been allowed to have go to `warn` instead. */
export function parseConfig(raw: unknown, warn: (message: string) => void = () => {}): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const c = raw as Record<string, any>;
  if (!Array.isArray(c.repos) || c.repos.length === 0) throw new Error('config.repos must list at least one repo');

  const models = parseModels(c.models, warn);
  const reviewers = parseReviewers(c.reviewers, models, c.models, warn);

  const repos = c.repos.map((r: Record<string, any>, i: number): RepoConfig => {
    if (typeof r.fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.fullName)) {
      throw new Error(`repos[${i}].fullName must look like "owner/name"`);
    }
    if (typeof r.localPath !== 'string') throw new Error(`repos[${i}].localPath is required`);
    const trigger: TriggerMode = r.trigger ?? 'auto';
    if (!TRIGGERS.includes(trigger)) throw new Error(`repos[${i}].trigger must be one of ${TRIGGERS.join(', ')}`);
    const authors = r.authors ?? [];
    if (!Array.isArray(authors) || authors.some((a) => typeof a !== 'string' || !a.trim())) {
      throw new Error(`repos[${i}].authors must be a list of GitHub logins`);
    }
    return {
      fullName: r.fullName,
      localPath: resolve(r.localPath.replace(/^~(?=\/|$)/, homedir())),
      trigger,
      postToPr: r.postToPr ?? true,
      github: { onPush: r.github?.onPush ?? false, mention: r.github?.mention ?? '@review-relay' },
      authors: [...new Set(authors.map(normalizeLogin))],
    };
  });

  const routes = parseRoutes(c.routes, {
    reviewers: Object.keys(models),
    repos: repos.map((repo: RepoConfig) => repo.fullName),
  });
  checkLabels([...reviewers, ...routes.flatMap((route) => route.reviewers ?? [])], models);

  const maxConcurrent = c.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a whole number of reviews, 1 or more');
  }

  const theme = c.theme ?? 'dark';
  if (!THEMES.includes(theme)) throw new Error(`theme must be one of ${THEMES.join(', ')}`);

  return {
    port: c.port ?? 9988,
    theme,
    graceMs: c.graceMs ?? 120_000,
    timeoutMs: c.timeoutMs ?? 30 * 60_000,
    maxConcurrent,
    reviewers,
    models,
    routes,
    dataDir: c.dataDir ? resolve(String(c.dataDir).replace(/^~(?=\/|$)/, homedir())) : DEFAULT_DATA_DIR,
    repos,
  };
}

export async function loadConfig(path = defaultConfigPath(), warn?: (message: string) => void): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config at ${path} (copy config.example.json there, or set REVIEW_RELAY_CONFIG)`);
  }
  return parseConfig(await file.json(), warn);
}

export const findRepo = (config: Config, fullName: string | undefined) =>
  config.repos.find((r) => r.fullName.toLowerCase() === fullName?.toLowerCase());
