/**
 * Word of a finished review: on the desktop, to an ntfy topic, to Slack, or to any webhook. A channel that fails is
 * reported to the caller and never fails the review.
 */
import type { NotifyConfig } from './config.ts';
import { exec, type ExecResult } from './exec.ts';
import { combinedScore } from './report.ts';
import { isLocal, type ResolvedJob, type ReviewerResult } from './types.ts';
import { mergeFindings, SEVERITIES, type Severity } from './verdict.ts';

/** A review that finished: with its results, or failed with an error. */
export interface ReviewNotice {
  job: ResolvedJob;
  results?: ReviewerResult[];
  /** The posted PR comment. */
  commentUrl?: string;
  error?: string;
}

/** What the webhook channel posts; the other channels send `title` and `text`. */
export interface NoticePayload {
  event: 'done' | 'failed';
  repo: string;
  /** 0 for a local review. */
  pr: number;
  branch?: string;
  local: boolean;
  headSha: string;
  score: number | null;
  findings: Record<Severity, number>;
  reviewers: { name: string; label: string; ok: boolean; score?: number }[];
  /** The PR comment, else the PR; unset for a local review. */
  url?: string;
  error?: string;
  title: string;
  text: string;
}

/**
 * The payload for a notice, or null when the config's `on` doesn't ask for it. A review where every reviewer failed
 * counts as failed, as it does everywhere else.
 */
export function noticePayload(config: NotifyConfig, notice: ReviewNotice): NoticePayload | null {
  const { job } = notice;
  const results = notice.results ?? [];
  const score = combinedScore(results);
  const failed = notice.error !== undefined || score === null;
  const wanted = failed
    ? config.on.includes('failed')
    : config.on.includes('done') || (config.on.includes('low') && score < config.minScore);
  if (!wanted) return null;

  const ok = results.filter((r) => r.ok && r.verdict);
  const merged = mergeFindings(ok.map((r) => ({ reviewer: r.name, findings: r.verdict!.findings })));
  const findings = Object.fromEntries(
    SEVERITIES.map((s) => [s, merged.filter((f) => f.severity === s).length]),
  ) as Record<Severity, number>;
  const local = isLocal(job);
  const error = notice.error ?? (failed ? 'every reviewer failed' : undefined);
  const counts = SEVERITIES.filter((s) => findings[s] > 0).map((s) => `${findings[s]} ${s}`);
  const perReviewer = results.map((r) => `${r.label} ${r.ok ? r.score : 'failed'}`).join(', ');
  const text = failed
    ? `Review failed: ${error}`
    : [`Confidence ${score}/5`, counts.length > 0 ? counts.join(', ') : 'no findings', perReviewer].join(' · ');
  return {
    event: failed ? 'failed' : 'done',
    repo: job.repo,
    pr: job.pr,
    ...(job.headRef ? { branch: job.headRef } : {}),
    local,
    headSha: job.headSha,
    score,
    findings,
    reviewers: results.map((r) => ({
      name: r.name,
      label: r.label,
      ok: r.ok,
      ...(r.score !== undefined ? { score: r.score } : {}),
    })),
    ...(local ? {} : { url: notice.commentUrl ?? `https://github.com/${job.repo}/pull/${job.pr}` }),
    ...(error ? { error } : {}),
    title: `review-relay: ${job.repo} ${local ? job.headRef : `#${job.pr}`}`,
    text,
  };
}

/** What sending touches, so tests can stand in for the network and the desktop. */
export interface NotifyDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  exec: (cmd: string[], opts: { env?: Record<string, string>; timeoutMs?: number }) => Promise<ExecResult>;
  platform: NodeJS.Platform;
  which: (bin: string) => string | null;
}

export const NOTIFY_DEPS: NotifyDeps = {
  fetch: (url, init) => fetch(url, init),
  exec,
  platform: process.platform,
  which: (bin) => Bun.which(bin),
};

const TIMEOUT_MS = 10_000;

/**
 * Shows a Windows toast through PowerShell's own app id, which Windows lets show toasts without registering one. The
 * text comes in through the environment as base64 UTF-8, so nothing needs quoting and WSLENV, which carries it from
 * WSL to Windows in the system code page, can't mangle it.
 */
const TOAST = `$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$decode = { param($b64) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
[void]$text.Item(0).AppendChild($xml.CreateTextNode((& $decode $env:RR_TITLE)))
[void]$text.Item(1).AppendChild($xml.CreateTextNode((& $decode $env:RR_TEXT)))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;

/** The command that shows a desktop notification here, or null when this machine has no way to. */
export function desktopCommand(
  title: string,
  text: string,
  deps: Pick<NotifyDeps, 'platform' | 'which'>,
): { cmd: string[]; env?: Record<string, string> } | null {
  if (deps.platform === 'darwin') {
    // Passed as arguments, so the text never becomes AppleScript.
    return {
      cmd: [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        text,
      ],
    };
  }
  const toast = (powershell: string) => ({
    cmd: [powershell, '-NoProfile', '-NonInteractive', '-Command', TOAST],
    env: {
      RR_TITLE: Buffer.from(title).toString('base64'),
      RR_TEXT: Buffer.from(text).toString('base64'),
      WSLENV: [process.env.WSLENV, 'RR_TITLE', 'RR_TEXT'].filter(Boolean).join(':'),
    },
  });
  if (deps.platform === 'win32') return toast('powershell.exe');
  const notifySend = deps.which('notify-send');
  if (notifySend) return { cmd: [notifySend, '--app-name=review-relay', title, text] };
  // WSL: no Linux notification daemon, but Windows is a process away.
  const powershell = deps.which('powershell.exe');
  return powershell ? toast(powershell) : null;
}

/** HTTP headers carry ASCII; ntfy reads RFC 2047 encoded words for anything else. */
const header = (value: string) =>
  // eslint-disable-next-line no-control-regex -- printable ASCII passes as is
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;

async function post(deps: NotifyDeps, url: string, init: RequestInit): Promise<void> {
  const res = await deps.fetch(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Sends the notice to every configured channel at once. Returns the failures, one line each, for the caller to log;
 * an empty list means every channel took it.
 */
export async function sendNotice(
  config: NotifyConfig,
  payload: NoticePayload,
  deps: NotifyDeps = NOTIFY_DEPS,
): Promise<string[]> {
  const { title, text, url } = payload;
  const channels: [string, () => Promise<void>][] = [];
  if (config.desktop) {
    channels.push([
      'desktop',
      async () => {
        const command = desktopCommand(title, text, deps);
        if (!command) throw new Error('no notify-send on PATH');
        const r = await deps.exec(command.cmd, { env: command.env, timeoutMs: TIMEOUT_MS });
        if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`);
      },
    ]);
  }
  if (config.ntfy) {
    const ntfy = config.ntfy;
    channels.push([
      'ntfy',
      () =>
        post(deps, ntfy, {
          body: text,
          headers: {
            Title: header(title),
            Tags:
              payload.event === 'failed'
                ? 'x'
                : (payload.score ?? 0) < config.minScore
                  ? 'warning'
                  : 'white_check_mark',
            ...(url ? { Click: url } : {}),
          },
        }),
    ]);
  }
  if (config.slack) {
    const slack = config.slack;
    channels.push([
      'slack',
      () =>
        post(deps, slack, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${text}${url ? `\n<${url}|Open>` : ''}` }),
        }),
    ]);
  }
  if (config.webhook) {
    const webhook = config.webhook;
    channels.push([
      'webhook',
      () => post(deps, webhook, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    ]);
  }
  const settled = await Promise.allSettled(channels.map(([, send]) => send()));
  return settled.flatMap((r, i) =>
    r.status === 'rejected'
      ? [`${channels[i]![0]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
      : [],
  );
}

/** Builds and sends the notice when the config asks for it, logging any channel that failed. */
export async function notify(
  config: NotifyConfig | undefined,
  notice: ReviewNotice,
  log: (message: string) => void,
  deps: NotifyDeps = NOTIFY_DEPS,
): Promise<void> {
  if (!config) return;
  const payload = noticePayload(config, notice);
  if (!payload) return;
  for (const failure of await sendNotice(config, payload, deps))
    log(`${payload.title}: notification failed: ${failure}`);
}
