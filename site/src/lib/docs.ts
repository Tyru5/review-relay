/** Public reference data. test/docs.test.ts checks defaults and examples against the CLI. */
export const DOC_SECTIONS = [
  ['quick-start', 'Quick start'],
  ['configuration', 'Configuration'],
  ['reviewers', 'Reviewers & models'],
  ['routing', 'Routing rules'],
  ['triggers', 'Triggers & review flow'],
  ['commands', 'CLI commands'],
  ['reports', 'Scores & reports'],
  ['security', 'Security & privacy'],
  ['troubleshooting', 'Troubleshooting'],
] as const;

export type ReferenceRow = readonly [name: string, defaultValue: string, description: string];

export const GLOBAL_OPTIONS: ReferenceRow[] = [
  ['repos', 'Required', 'Non-empty list of GitHub repositories and their local clones.'],
  ['port', '9988', 'Local webhook server port. Listens on 127.0.0.1 only.'],
  ['graceMs', '120000', 'In auto mode, wait this many milliseconds for Greptile before the GitHub fallback runs.'],
  ['timeoutMs', '1800000', 'Per-reviewer timeout in milliseconds. The default is 30 minutes.'],
  ['reviewers', '["codex","claude"]', 'Fallback panel when no route matches. At least one reviewer ID is required.'],
  [
    'models',
    'Built-in entries',
    'Model, effort, provider, and display label per reviewer. Custom entries also name a harness.',
  ],
  ['routes', '[]', 'Ordered rules that select reviewers or skip an automatic review.'],
  [
    'dataDir',
    '~/.review-relay',
    'Reports, state, logs, and temporary worktrees. Does not change the config file location.',
  ],
];

export const REPO_OPTIONS: ReferenceRow[] = [
  ['fullName', 'Required', 'GitHub owner/name, for example acme/widget.'],
  [
    'localPath',
    'Required',
    'Existing local clone with an origin remote for this repository. ~/ expands to your home. Relative paths resolve from the process working directory.',
  ],
  ['trigger', 'auto', 'auto, greptile, or github. Mentions work in every mode.'],
  ['postToPr', 'true', 'Publish the report as a PR comment. Set false for local reports only; reviewers still run.'],
  [
    'github.onPush',
    'false',
    'Also handle pull_request.synchronize when new commits are pushed. Applies to github and auto modes.',
  ],
  [
    'github.mention',
    '@review-relay',
    'Case-insensitive text that requests a review in a new PR comment. Use a non-empty mention.',
  ],
];

export const MODEL_OPTIONS: ReferenceRow[] = [
  ['harness', 'Required for custom IDs', 'One of the supported CLI IDs below. A built-in ID always uses its own CLI.'],
  [
    'label',
    'CLI label or custom ID',
    'Name shown in the PR comment. Active reviewer labels must be unique, ignoring case.',
  ],
  [
    'model',
    'Harness default',
    'Model identifier accepted by the CLI. Omit to use the relay default below, or the CLI default when none is set.',
  ],
  [
    'effort',
    'Harness default',
    'Reasoning setting for CLIs that support it. Model and CLI versions determine which values work.',
  ],
  ['provider', 'Not set', 'Hermes only. Provider identifier, separate from the model name.'],
];

export const REVIEWERS = [
  { id: 'claude', product: 'Claude Code', model: 'claude-opus-5-5', effort: 'max', supportsEffort: true },
  { id: 'codex', product: 'Codex CLI', model: 'gpt-6-astra', effort: 'high', supportsEffort: true },
  { id: 'auggie', product: 'Augment Auggie', supportsEffort: true },
  { id: 'copilot', product: 'GitHub Copilot CLI', supportsEffort: true },
  { id: 'droid', product: 'Factory Droid', supportsEffort: true },
  { id: 'gemini', product: 'Gemini CLI', supportsEffort: false },
  { id: 'grok', product: 'Grok Build', supportsEffort: true },
  { id: 'hermes', product: 'Hermes Agent', supportsEffort: true },
  { id: 'kilo', product: 'Kilo Code CLI', supportsEffort: true },
  { id: 'opencode', product: 'opencode', supportsEffort: true },
  { id: 'pi', product: 'pi', supportsEffort: true },
  { id: 'qwen', product: 'Qwen Code', supportsEffort: false },
  { id: 'vibe', product: 'Mistral Vibe', supportsEffort: false },
] as const;

export const ROUTE_OPTIONS: ReferenceRow[] = [
  ['name', 'Required', 'Unique ID, up to 32 lowercase letters, digits, and dashes; starts with a letter or digit.'],
  ['when', 'Required', 'Non-empty object of conditions below. All conditions must match.'],
  [
    'reviewers',
    'Either reviewers or skip',
    'Non-empty list of known reviewer IDs, without duplicates. Replaces the fallback panel.',
  ],
  ['skip', 'Omit for review routes', 'Set true instead of reviewers to skip. Skip routes cannot set timeoutMs.'],
  [
    'timeoutMs',
    'Global timeoutMs',
    'Positive integer in milliseconds. Overrides the timeout for each reviewer on this route.',
  ],
];

export const ROUTE_CONDITIONS: ReferenceRow[] = [
  ['repos', 'Glob list', 'Match owner/name, ignoring case. Each pattern must match at least one configured repo.'],
  ['baseBranches', 'Glob list', 'Match the target branch, not the PR head branch. Case-sensitive.'],
  ['sources', 'Value list', 'greptile, github, mention, or manual.'],
  ['paths', 'Glob list', 'At least one changed path matches. Includes the old path of a renamed file.'],
  [
    'onlyPaths',
    'Glob list',
    'Every changed path must match at least one pattern, including both sides of renames. Empty diffs do not match.',
  ],
  ['minLines', 'Integer ≥ 0', 'Minimum additions + deletions, inclusive, excluding recognized lockfiles.'],
  ['maxLines', 'Integer ≥ 0', 'Maximum additions + deletions, inclusive, excluding recognized lockfiles.'],
  ['minFiles', 'Integer ≥ 0', 'Minimum number of changed non-lockfiles, inclusive.'],
  ['maxFiles', 'Integer ≥ 0', 'Maximum number of changed non-lockfiles, inclusive.'],
  [
    'wideImpact',
    'Boolean',
    'Match changes to recognized dependency manifests, CI, migrations, schemas, SQL, environment files, and other sensitive paths. False matches their absence.',
  ],
];

export const COMMANDS: ReferenceRow[] = [
  [
    'setup',
    'No required flags',
    'Interactive repo and reviewer selection. Writes the config and preserves settings it does not ask about.',
  ],
  ['start', '-d, --detach', 'Watch repos. Foreground by default; -d runs in the background and writes daemon.log.'],
  ['stop', 'No flags', 'Stop the background daemon. Attempts graceful shutdown, then forces exit after 20 seconds.'],
  ['restart', 'No flags', 'Stop, then start in the background. Use after editing config.'],
  [
    'status',
    '--limit <n>, --page <n>',
    'Daemon, endpoint, forwarders, and recent jobs. 20 jobs per page; --page reaches older ones. Exits 3 when the daemon is not running.',
  ],
  [
    'tui',
    'No flags',
    'Live terminal view of the jobs. Enter opens scores, findings, and the posted comment; r re-reviews a PR, o opens it, / filters.',
  ],
  ['logs', '[N], -f, --follow', 'Read the last N log lines, default 50. Use -f to follow new output.'],
  [
    'run',
    '--repo <owner/name> --pr <n> [--route <name>]',
    'Review an open PR now, including a previously reviewed commit. Can publish a comment.',
  ],
  [
    'route',
    '--repo <owner/name> --pr <n> [--source <source>]',
    'Explain matching rules without running reviewers or posting. Fetches the PR and base refs. Default source: github.',
  ],
  [
    'replay',
    '<events.jsonl> --dry-run --grace <ms>',
    'Process recorded deliveries. --dry-run logs would-run jobs; --grace overrides the auto-mode wait for this replay.',
  ],
  ['info', '--json', 'Resolved configuration and diagnostics. --json prints machine-readable output.'],
  ['config', 'No flags', 'Print the resolved configuration as JSON.'],
  ['help', '[command]', 'List commands, or show a command’s options and examples.'],
];

export const ENVIRONMENT: ReferenceRow[] = [
  [
    'REVIEW_RELAY_CONFIG',
    '~/.review-relay/config.json',
    'Config path for the CLI and installers. --config takes precedence in the CLI.',
  ],
  [
    'REVIEW_RELAY_DEBUG',
    'Not set',
    'Any non-empty value logs why webhook events were ignored. Set before starting the daemon.',
  ],
  ['NO_COLOR', 'Not set', 'A non-empty value disables CLI color, even if FORCE_COLOR is set.'],
  ['FORCE_COLOR', 'Not set', 'A non-empty value other than 0 enables CLI color.'],
  [
    'REVIEW_RELAY_INSTALL_VERSION',
    'latest',
    'Installer release version. Unix --version and PowerShell -Version take precedence.',
  ],
  [
    'REVIEW_RELAY_INSTALL_BIN_DIR',
    'Platform default',
    'Installer destination. Unix --bin-dir and PowerShell -BinDir take precedence.',
  ],
  [
    'REVIEW_RELAY_INSTALL_REPO',
    'Tyru5/review-relay',
    'GitHub repo to download releases from. Only use a repo you trust.',
  ],
  [
    'REVIEW_RELAY_INSTALL_NO_MODIFY_PATH',
    'Not set',
    'Windows only. Any non-empty value prevents PATH changes; equivalent to -NoModifyPath.',
  ],
  [
    'REVIEW_RELAY_INSTALL_NO_ALIAS',
    'Not set',
    'Any non-empty value skips the rr shortcut; equivalent to --no-alias or -NoAlias.',
  ],
];

export const QUICK_CONFIG = {
  reviewers: ['codex', 'claude'],
  repos: [{ fullName: 'acme/widget', localPath: '~/code/widget', trigger: 'github', postToPr: false }],
};

export const ROUTED_CONFIG = {
  reviewers: ['codex', 'claude'],
  models: {
    'codex-deep': { harness: 'codex', label: 'Codex deep', model: 'gpt-6-astra', effort: 'high' },
  },
  routes: [
    { name: 'docs-only', when: { onlyPaths: ['docs/**', '**/*.md'] }, skip: true },
    { name: 'sensitive', when: { wideImpact: true }, reviewers: ['codex-deep', 'claude'], timeoutMs: 2400000 },
    { name: 'small', when: { maxLines: 100, maxFiles: 5 }, reviewers: ['codex'] },
  ],
  repos: [{ fullName: 'acme/widget', localPath: '~/code/widget', trigger: 'auto', postToPr: false }],
};
