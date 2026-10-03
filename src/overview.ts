/**
 * The `status` header (daemon, endpoint, forwarders) and the `info` screen (resolved config).
 * Both are pure: they take what the CLI already looked up and return lines.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { DaemonState } from './daemon.ts';
import { HARNESSES } from './reviewers/index.ts';
import type { ReviewerId } from './types.ts';
import { fmtDuration, padVisible, row, section, tildify, type Styles } from './ui.ts';

export interface OverviewOptions {
  version: string;
  configPath: string;
  logPath: string;
  now?: number;
}

/** Lines for the daemon block of `status`; `exitCode` is 3 when the daemon is not running (scripts can test it). */
export function renderDaemon(
  state: DaemonState,
  opts: OverviewOptions,
  st: Styles,
): { lines: string[]; exitCode: number } {
  const lines: string[] = [
    `${st.title('review-relay')}  ${st.muted(`v${opts.version}`)}`,
    row(st, 'config', tildify(opts.configPath)),
    ...section(st, 'Daemon'),
  ];
  const endpoint = `http://127.0.0.1:${state.port}/hook`;
  if (!state.running) {
    const why = state.stale
      ? `stale record: pid ${state.pid} is not a review-relay process`
      : state.foreign
        ? `something else answers /health on :${state.port}`
        : undefined;
    lines.push(row(st, 'status', st.badge(state.foreign ? 'warning' : 'danger', 'stopped'), why));
    lines.push(row(st, 'endpoint', st.muted(endpoint)));
    lines.push(row(st, 'log', tildify(opts.logPath)));
    lines.push(
      ...section(st, 'Next steps'),
      `  ${st.command('review-relay start -d'.padEnd(26))}start the daemon in the background`,
      `  ${st.command('review-relay logs'.padEnd(26))}see why the last run stopped`,
    );
    return { lines, exitCode: 3 };
  }

  const uptime = state.uptimeMs === null ? null : `up ${fmtDuration(state.uptimeMs)}`;
  const detail = [`pid ${state.pid}`, uptime, state.version ? `v${state.version}` : null].filter(Boolean).join(' • ');
  lines.push(row(st, 'status', st.badge('success', 'running'), detail));
  const health =
    state.health === 'ok'
      ? st.badge('success', 'healthy')
      : st.badge('danger', state.health === 'unexpected' ? 'unexpected reply' : 'unreachable');
  lines.push(row(st, 'endpoint', endpoint, undefined), row(st, 'health', health, `GET /health on :${state.port}`));
  lines.push(row(st, 'log', tildify(opts.logPath)));

  lines.push(...section(st, 'Forwarders'));
  if (state.forwarders.length === 0) {
    const why =
      state.version === null
        ? 'started by an older version; restart to track forwarders here'
        : 'the daemon has not spawned gh webhook forward yet';
    lines.push(`  ${st.badge('warning', 'none recorded')}  ${st.muted(why)}`);
  } else {
    const now = opts.now ?? Date.now();
    const repoW = Math.max(...state.forwarders.map((f) => f.repo.length));
    for (const f of state.forwarders) {
      const tone = f.alive ? 'success' : 'danger';
      const meta = [
        f.pid ? `pid ${f.pid}` : 'no process',
        f.alive ? `up ${fmtDuration(now - Date.parse(f.since))}` : 'restarting',
        f.restarts ? `${f.restarts} restart${f.restarts === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' • ');
      lines.push(`  ${st.dot(tone)} ${padVisible(f.repo, repoW)}  ${st.muted(f.events)}  ${st.muted(meta)}`);
    }
    const dead = state.forwarders.filter((f) => !f.alive).length;
    if (dead) lines.push(`  ${st.badge('warning', `${dead} of ${state.forwarders.length} forwarders down`)}`);
  }
  return { lines, exitCode: 0 };
}

export interface InfoOptions extends OverviewOptions {
  /** Executable found for each configured reviewer, or null when it is not on PATH. */
  bins: Partial<Record<ReviewerId, string | null>>;
  /** Mtime of the config file, to flag edits newer than the daemon. */
  configMtimeMs: number | null;
  daemon: DaemonState;
}

export function renderInfo(config: Config, opts: InfoOptions, st: Styles): string[] {
  const started = opts.daemon.running && opts.daemon.startedAt ? Date.parse(opts.daemon.startedAt) : null;
  const fileNote = !opts.daemon.running
    ? 'daemon stopped; shown as it would load'
    : started !== null && opts.configMtimeMs !== null && opts.configMtimeMs > started
      ? 'edited since the daemon started; restart to apply'
      : undefined;
  const fileNoteTone = fileNote?.startsWith('edited') ? 'warning' : 'muted';

  const lines: string[] = [
    `${st.title('review-relay')}  ${st.muted(`v${opts.version}`)}`,
    row(st, 'config', tildify(opts.configPath), undefined),
    ...(fileNote ? [`  ${' '.repeat(12)}${st.tone(fileNoteTone, fileNote)}`] : []),
    row(st, 'port', String(config.port)),
    row(st, 'grace', fmtDuration(config.graceMs), 'auto mode waits this long for Greptile'),
    row(st, 'timeout', fmtDuration(config.timeoutMs), 'per reviewer'),
    row(st, 'dataDir', tildify(config.dataDir)),
    ...section(st, 'Reviewers'),
  ];

  const nameW = Math.max(...config.reviewers.map((n) => n.length));
  for (const name of config.reviewers) {
    const m = config.models[name]!;
    const bin = opts.bins[name];
    const picks = [
      m.model ?? 'default model',
      m.effort ? `effort ${m.effort}` : null,
      m.provider ? `via ${m.provider}` : null,
      m.harness !== name ? `on ${m.harness}` : null,
    ]
      .filter(Boolean)
      .join('  ');
    const where = bin
      ? st.muted(tildify(bin))
      : st.badge('danger', `${HARNESSES[m.harness].bins.join(' or ')} not on PATH`);
    lines.push(`  ${st.dot(bin ? 'success' : 'danger')} ${name.padEnd(nameW)}  ${picks.padEnd(32)}  ${where}`);
  }

  lines.push(...section(st, 'Repos'));
  for (const repo of config.repos) {
    const exists = existsSync(join(repo.localPath, '.git'));
    lines.push(`  ${st.dot(exists ? 'success' : 'danger')} ${st.bold(repo.fullName)}`);
    const flags = [
      `trigger ${repo.trigger}`,
      `post ${repo.postToPr ? 'on' : 'off'}`,
      `onPush ${repo.github.onPush ? 'on' : 'off'}`,
      `mention ${repo.github.mention}`,
    ];
    lines.push(`      ${st.muted(flags.join('  '))}`);
    lines.push(`      ${tildify(repo.localPath)}${exists ? '' : `  ${st.tone('danger', 'no clone here')}`}`);
  }
  return lines;
}
