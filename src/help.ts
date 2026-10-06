/**
 * `review-relay --help` and `review-relay help <command>`.
 *
 * The overview keeps one short line per command so it scans; arguments, options, and examples live
 * on each command's own page. Everything wraps to the terminal width with a hanging indent.
 */
import { styles, visibleLength, type Styles } from './ui.ts';

interface Flag {
  flag: string;
  description: string;
}

export interface CommandHelp {
  name: string;
  /** Arguments after the name, as shown on the usage line. */
  args?: string;
  /** One line for the overview. */
  summary: string;
  /** Extra sentences for the command's own page. */
  detail?: string[];
  options?: Flag[];
  examples?: string[];
}

interface Group {
  title: string;
  commands: CommandHelp[];
}

export const HELP_GROUPS: Group[] = [
  {
    title: 'Daemon',
    commands: [
      {
        name: 'start',
        args: '[-d]',
        summary: 'Watch the configured repos and review PRs as triggers arrive',
        detail: [
          'Runs the webhook server on 127.0.0.1 and one `gh webhook forward` per repo. Each forwarder creates a temporary repo webhook and deletes it on shutdown.',
          'In the foreground, logs stream to the terminal until ctrl-c. With -d the daemon runs in the background and logs to <dataDir>/daemon.log.',
        ],
        options: [{ flag: '-d, --detach', description: 'Run in the background and print the status' }],
        examples: ['review-relay start', 'review-relay start -d'],
      },
      {
        name: 'stop',
        summary: 'Stop the background daemon and remove its temporary webhooks',
        detail: ['Sends SIGTERM so the daemon can delete its repo webhooks; forces the exit after 20s.'],
        examples: ['review-relay stop'],
      },
      {
        name: 'restart',
        summary: 'Stop the daemon, then start it again in the background',
        examples: ['review-relay restart'],
      },
      {
        name: 'tui',
        summary: 'Live terminal view of the review jobs: open one, read its findings, re-run it',
        detail: [
          'Lists every job in state.json with its score per reviewer and finding counts, refreshing as the daemon writes. Enter opens a job (scores, merged findings, the posted comment, or its log lines while running); / filters; s cycles the status filter.',
          'r reviews the PR again in the background, o opens it in the browser, y copies its URL. Press ? inside for every key.',
        ],
        examples: ['review-relay tui'],
      },
      {
        name: 'status',
        args: '[--limit N] [--page N]',
        summary: 'Daemon, endpoint, forwarders, and recent review jobs',
        detail: ['Exits 3 when the daemon is not running, so scripts can test it.'],
        options: [
          { flag: '--limit <n>', description: 'Review jobs per page (default 20)' },
          { flag: '--page <n>', description: 'Page of jobs, newest first (default 1)' },
        ],
        examples: ['review-relay status', 'review-relay status --limit 5', 'review-relay status --page 2'],
      },
      {
        name: 'logs',
        args: '[N] [-f]',
        summary: 'Show the daemon log',
        options: [
          { flag: 'N', description: 'Lines to show (default 50)' },
          { flag: '-f, --follow', description: 'Keep printing new lines' },
        ],
        examples: ['review-relay logs', 'review-relay logs 200', 'review-relay logs -f'],
      },
    ],
  },
  {
    title: 'Reviews',
    commands: [
      {
        name: 'run',
        args: '--repo <owner/name> --pr <N> [--route <name>]',
        summary: 'Review one open PR now',
        detail: [
          'Skips the dedupe check, so a commit that was already reviewed runs again.',
          'Never skipped by a skip route. With --route, the named route reviews the PR even when another route matches first.',
        ],
        options: [
          { flag: '--repo <owner/name>', description: 'A repo from the config' },
          { flag: '--pr <n>', description: 'Pull request number' },
          { flag: '--route <name>', description: 'Use this route instead of the one the PR matches' },
        ],
        examples: [
          'review-relay run --repo owner/repo --pr 42',
          'review-relay run --repo owner/repo --pr 42 --route risky',
        ],
      },
      {
        name: 'route',
        args: '--repo <owner/name> --pr <N> [--source <source>]',
        summary: 'Show which route a PR matches and why, without reviewing it',
        detail: [
          'Fetches the PR, open or closed, checks every route in order, and prints the first condition each one failed and the reviewers the PR would get. Posts nothing and leaves job state alone.',
        ],
        options: [
          { flag: '--repo <owner/name>', description: 'A repo from the config' },
          { flag: '--pr <n>', description: 'Pull request number' },
          {
            flag: '--source <source>',
            description: 'Trigger to check as: github (default), greptile, mention, manual',
          },
        ],
        examples: [
          'review-relay route --repo owner/repo --pr 42',
          'review-relay route --repo owner/repo --pr 42 --source mention',
        ],
      },
      {
        name: 'replay',
        args: '<events.jsonl> [--dry-run] [--grace <ms>]',
        summary: 'Feed recorded webhook deliveries through the trigger logic',
        detail: ['The file holds one {"event", "payload"} object per line, as `gh webhook forward` prints them.'],
        options: [
          { flag: '--dry-run', description: 'Log what would run instead of running reviewers' },
          { flag: '--grace <ms>', description: 'Override graceMs for this replay' },
        ],
        examples: ['review-relay replay events.jsonl --dry-run', 'review-relay replay events.jsonl --grace 0'],
      },
    ],
  },
  {
    title: 'Configuration',
    commands: [
      {
        name: 'setup',
        summary: 'Pick repos, reviewers, and models in a terminal UI',
        detail: ['Creates the config file when it is missing and keeps settings it does not ask about.'],
        examples: ['review-relay setup', 'review-relay setup --config ./relay.json'],
      },
      {
        name: 'info',
        args: '[--json]',
        summary: 'Show the resolved config, with defaults applied',
        detail: [
          'Flags edits the running daemon has not loaded, reviewers missing from PATH, and repos with no clone.',
        ],
        options: [{ flag: '--json', description: 'Print the resolved config as JSON' }],
        examples: ['review-relay info', 'review-relay info --json'],
      },
      {
        name: 'config',
        summary: 'Print the resolved config as JSON',
        examples: ['review-relay config | jq .repos'],
      },
    ],
  },
];

export const GLOBAL_FLAGS: Flag[] = [
  {
    flag: '--config <path>',
    description: 'Config file (default ~/.review-relay/config.json, or $REVIEW_RELAY_CONFIG)',
  },
  { flag: '-h, --help', description: 'Help for review-relay or for one command' },
  { flag: '-v, --version', description: 'Print the version' },
];

export const findCommandHelp = (name: string): CommandHelp | undefined =>
  HELP_GROUPS.flatMap((g) => g.commands).find((c) => c.name === name);

/** Terminal width to wrap to: the real one, kept between 60 and 100 columns so lines stay readable. */
export function helpWidth(columns = process.stdout.columns): number {
  return Math.min(100, Math.max(60, columns ?? 80));
}

/** Wraps `text` into lines of at most `width` characters. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Two columns: a painted term, then text that wraps with a hanging indent under itself. */
function entry(st: Styles, indent: number, term: string, termWidth: number, text: string, width: number): string[] {
  const pad = ' '.repeat(indent);
  const gap = 2;
  const column = indent + termWidth + gap;
  const painted = st.command(term);
  // A term wider than its column pushes the text onto the next line instead of breaking alignment.
  if (term.length > termWidth) {
    return [`${pad}${painted}`, ...wrap(text, width - column).map((l) => `${' '.repeat(column)}${l}`)];
  }
  const [first = '', ...rest] = wrap(text, width - column);
  const head = `${pad}${painted}${' '.repeat(termWidth - visibleLength(term) + gap)}${first}`;
  return [head.trimEnd(), ...rest.map((l) => `${' '.repeat(column)}${l}`)];
}

const paragraph = (text: string, width: number, indent = 2) =>
  wrap(text, width - indent).map((l) => `${' '.repeat(indent)}${l}`);

export function renderHelp(version: string, st: Styles = styles(), width = helpWidth()): string {
  const termWidth = Math.max(...HELP_GROUPS.flatMap((g) => g.commands.map((c) => c.name.length)), 8);
  const lines: string[] = [
    `${st.title('review-relay')}  ${st.muted(`v${version}`)}`,
    ...paragraph(
      'Local AI code review for pull requests. Runs your agent CLIs when Greptile or GitHub says a PR is ready, and posts the verdict back.',
      width,
      0,
    ),
    '',
    `${st.section('Usage')}  ${st.command('review-relay')} ${st.muted('<command> [options]')}`,
    `${' '.repeat(7)}${st.command('review-relay')} ${st.muted('help <command>')}`,
    '',
    st.section('Quick start'),
  ];
  const steps: [string, string][] = [
    ['review-relay setup', 'pick repos, reviewers, and models'],
    ['review-relay start -d', 'run the daemon in the background'],
    ['review-relay status', 'confirm it is listening and forwarding'],
  ];
  const stepWidth = Math.max(...steps.map(([c]) => c.length));
  steps.forEach(([c, what], i) => {
    const [head = '', ...rest] = entry(st, 0, c, stepWidth, what, width - 5);
    lines.push(`  ${st.muted(`${i + 1}.`)} ${head}`, ...rest.map((l) => `     ${l}`));
  });
  for (const group of HELP_GROUPS) {
    lines.push('', st.section(group.title));
    for (const cmd of group.commands) lines.push(...entry(st, 2, cmd.name, termWidth, cmd.summary, width));
  }
  lines.push('', st.section('Options'));
  const flagWidth = Math.max(...GLOBAL_FLAGS.map((f) => f.flag.length));
  for (const f of GLOBAL_FLAGS) lines.push(...entry(st, 2, f.flag, flagWidth, f.description, width));
  lines.push(
    '',
    ...paragraph('Run review-relay help <command> for arguments, options, and examples.', width, 0).map(st.muted),
  );
  return lines.join('\n');
}

/** The page for one command, or null when the name is unknown. */
export function renderCommandHelp(
  name: string,
  version: string,
  st: Styles = styles(),
  width = helpWidth(),
): string | null {
  const cmd = findCommandHelp(name);
  if (!cmd) return null;
  const usage = ['review-relay', cmd.name, cmd.args].filter(Boolean).join(' ');
  const lines: string[] = [
    `${st.title(`review-relay ${cmd.name}`)}  ${st.muted(`v${version}`)}`,
    ...paragraph(cmd.summary, width, 0),
    '',
    `${st.section('Usage')}  ${st.command(usage)}`,
  ];
  if (cmd.detail?.length) {
    lines.push('');
    for (const d of cmd.detail) lines.push(...paragraph(d, width));
  }
  const options = [...(cmd.options ?? []), ...GLOBAL_FLAGS.filter((f) => f.flag.startsWith('--config'))];
  lines.push('', st.section('Options'));
  const flagWidth = Math.max(...options.map((f) => f.flag.length));
  for (const f of options) lines.push(...entry(st, 2, f.flag, flagWidth, f.description, width));
  if (cmd.examples?.length) {
    lines.push('', st.section('Examples'));
    for (const e of cmd.examples) lines.push(`  ${st.muted('$')} ${st.command(e)}`);
  }
  return lines.join('\n');
}
