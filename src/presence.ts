/** Authenticated, advisory presence through a shared private GitHub issue. Never a distributed lock. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PresenceConfig } from './config.ts';
import { exec } from './exec.ts';
import { sanitize } from './ui.ts';

export const HEARTBEAT_MS = 60_000;
export const PRESENCE_STALE_MS = 3 * HEARTBEAT_MS;
const MARKER = '<!-- review-relay:presence:v1\n';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export interface PresenceSession {
  instanceId: string;
  sessionId: string;
  label: string;
  version: string;
  /** Running means a forwarder process exists, not that its hook is healthy. */
  repos: { name: string; state: 'starting' | 'running' | 'standby' | 'down' }[];
}

export interface RemoteInstance extends PresenceSession {
  account: string;
  commentId: number;
  updatedAt: string;
  stopped: boolean;
}

export interface PresenceSnapshot {
  state: 'disabled' | 'ok' | 'unknown';
  instances: RemoteInstance[];
  /** Local observation time plus GitHub's clock, so laptop clock skew does not expire other machines. */
  checkedAt: number;
  serverTime?: number;
  error?: string;
}

export type PresenceRequest = (
  path: string,
  method?: 'GET' | 'POST' | 'PATCH',
  body?: { body: string },
  signal?: AbortSignal,
) => Promise<{ data: unknown; serverTime: number }>;

class PresenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt = 0,
  ) {
    super(message);
  }
}

/** Only github.com is supported by gh-webhook. Do not accidentally publish to GH_HOST instead. */
const githubRequest: PresenceRequest = async (path, method = 'GET', body, signal) => {
  const result = await exec(
    ['gh', 'api', '--hostname', 'github.com', '--include', '--method', method, path, ...(body ? ['--input', '-'] : [])],
    { stdin: body ? JSON.stringify(body) : undefined, timeoutMs: 10_000, signal },
  );
  const split = /\r?\n\r?\n/.exec(result.stdout);
  const head = split ? result.stdout.slice(0, split.index) : '';
  const headers = new Headers();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(head)?.[1]);
  const serverTime = Date.parse(headers.get('date') ?? '');
  if (result.code !== 0 || status < 200 || status >= 300 || !status) {
    const retry = headers.get('retry-after');
    const reset = headers.get('x-ratelimit-reset');
    const clock = Number.isFinite(serverTime) ? serverTime : Date.now();
    const retryAt =
      Date.now() +
      Math.max(
        HEARTBEAT_MS,
        retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - clock || 0) : 0,
        headers.get('x-ratelimit-remaining') === '0' && reset ? Number(reset) * 1000 - clock || 0 : 0,
      );
    throw new PresenceApiError(
      result.timedOut
        ? 'GitHub presence request timed out'
        : `GitHub presence request failed${status ? ` (HTTP ${status})` : ''}; check gh authentication and registry access`,
      status,
      status === 403 || status === 429 ? retryAt : 0,
    );
  }
  if (!Number.isFinite(serverTime)) throw new Error('GitHub did not provide a clock for presence');
  return { data: JSON.parse(result.stdout.slice(split!.index + split![0].length)), serverTime };
};

export const disabledPresence = (): PresenceSnapshot => ({ state: 'disabled', instances: [], checkedAt: Date.now() });

export function presenceState(instance: RemoteInstance, serverNow: number): 'recent' | 'stale' | 'stopped' {
  if (instance.stopped) return 'stopped';
  const age = serverNow - Date.parse(instance.updatedAt);
  return age >= 0 && age < PRESENCE_STALE_MS ? 'recent' : 'stale';
}

export const presenceNow = (snapshot: PresenceSnapshot, now = Date.now()) =>
  (snapshot.serverTime ?? 0) + Math.max(0, now - snapshot.checkedAt);

/** Recently seen peers watching at least one of our repos. Never infer absence from a failed read. */
export function overlappingInstances(
  snapshot: PresenceSnapshot,
  repos: string[],
  ownSession?: string,
  now = Date.now(),
): RemoteInstance[] {
  if (snapshot.state !== 'ok') return [];
  const names = new Set(repos.map((r) => r.toLowerCase()));
  return snapshot.instances.filter(
    (i) =>
      i.sessionId !== ownSession &&
      presenceState(i, presenceNow(snapshot, now)) === 'recent' &&
      i.repos.some((r) => names.has(r.name.toLowerCase())),
  );
}

function parseComment(raw: any): RemoteInstance | null {
  if (typeof raw?.body !== 'string' || !raw.body.startsWith('<!-- review-relay:presence:')) return null;
  if (!raw.body.startsWith(MARKER) || !raw.body.endsWith('\n-->') || raw.body.length > 64_000)
    throw new Error('Unsupported or malformed presence record in registry');
  const data = JSON.parse(raw.body.slice(MARKER.length, -4));
  if (
    !data ||
    !UUID.test(data.instanceId) ||
    !UUID.test(data.sessionId) ||
    typeof data.label !== 'string' ||
    !data.label.trim() ||
    data.label.length > 80 ||
    typeof data.version !== 'string' ||
    data.version.length > 80 ||
    typeof data.stopped !== 'boolean' ||
    !Array.isArray(data.repos) ||
    data.repos.length > 1000 ||
    data.repos.some(
      (r: any) =>
        !r ||
        typeof r.name !== 'string' ||
        !REPO.test(r.name) ||
        !['starting', 'running', 'standby', 'down'].includes(r.state),
    ) ||
    !Number.isSafeInteger(raw.id) ||
    raw.id < 1 ||
    typeof raw.user?.login !== 'string' ||
    !raw.user.login ||
    !Number.isFinite(Date.parse(raw.updated_at))
  )
    throw new Error('Malformed presence record in registry');
  return {
    instanceId: data.instanceId,
    sessionId: data.sessionId,
    label: sanitize(data.label),
    version: sanitize(data.version),
    repos: data.repos.map((r: PresenceSession['repos'][number]) => ({ name: r.name, state: r.state })),
    account: sanitize(raw.user.login),
    commentId: raw.id,
    updatedAt: raw.updated_at,
    stopped: data.stopped,
  };
}

export class PresenceRegistry {
  private retryAt = 0;
  private comments = new Map<string, number>();
  private uncertain = new Set<string>();
  private last = disabledPresence();

  constructor(
    readonly config: PresenceConfig,
    private readonly request: PresenceRequest = githubRequest,
    private readonly signal?: AbortSignal,
  ) {}

  private async call(path: string, method?: 'GET' | 'POST' | 'PATCH', body?: { body: string }, signal = this.signal) {
    signal?.throwIfAborted();
    if (Date.now() < this.retryAt) throw new Error('GitHub presence is rate limited; waiting before retrying');
    try {
      return await this.request(path, method, body, signal);
    } catch (error) {
      if (error instanceof PresenceApiError) this.retryAt = error.retryAt;
      throw error;
    }
  }

  private async checkRegistry(signal?: AbortSignal): Promise<number> {
    const reply = await this.call(`repos/${this.config.repo}`, 'GET', undefined, signal);
    if ((reply.data as { private?: boolean })?.private !== true)
      throw new Error('Presence registry must be a private repository');
    return reply.serverTime;
  }

  private async list(
    serverTime: number,
    signal?: AbortSignal,
  ): Promise<{ instances: RemoteInstance[]; serverTime: number }> {
    const instances: RemoteInstance[] = [];
    // Bound history, not identities: any live heartbeat updates its comment into this window.
    const since = encodeURIComponent(new Date(serverTime - 24 * 60 * 60_000).toISOString());
    for (let page = 1; page <= 20; page++) {
      const reply = await this.call(
        `repos/${this.config.repo}/issues/${this.config.issue}/comments?per_page=100&page=${page}&since=${since}`,
        'GET',
        undefined,
        signal,
      );
      serverTime = Math.max(serverTime, reply.serverTime);
      if (!Array.isArray(reply.data)) throw new Error('Invalid GitHub presence response');
      for (const raw of reply.data) {
        const instance = parseComment(raw);
        if (instance) instances.push(instance);
      }
      if (reply.data.length < 100) return { instances, serverTime };
    }
    throw new Error('Presence registry has too many recent comments; cannot confirm all instances');
  }

  async read(): Promise<PresenceSnapshot> {
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(this.signal ? [this.signal] : [])]);
    try {
      const serverTime = await this.checkRegistry(signal);
      const listed = await this.list(serverTime, signal);
      this.last = { state: 'ok', ...listed, checkedAt: Date.now() };
    } catch (error) {
      this.last = {
        ...this.last,
        state: 'unknown',
        error: sanitize(error instanceof Error ? error.message : String(error)),
      };
    }
    return this.last;
  }

  /** One comment per session. Reconcile uncertain POST outcomes before trying another creation. */
  async publish(session: PresenceSession, stopped: boolean, shutdownSignal?: AbortSignal): Promise<void> {
    const signal =
      shutdownSignal ?? AbortSignal.any([AbortSignal.timeout(15_000), ...(this.signal ? [this.signal] : [])]);
    const serverTime = await this.checkRegistry(signal);
    let id = this.comments.get(session.sessionId);
    if (id === undefined) {
      id = (await this.list(serverTime, signal)).instances.find(
        (i) => i.sessionId === session.sessionId && i.instanceId === session.instanceId,
      )?.commentId;
    }
    if (id === undefined && this.uncertain.has(session.sessionId))
      throw new Error(
        'Presence creation outcome is uncertain; waiting for the original comment before publishing again',
      );
    const body = { body: `${MARKER}${JSON.stringify({ ...session, stopped, heartbeat: randomUUID() })}\n-->` };
    try {
      if (id === undefined) this.uncertain.add(session.sessionId);
      const reply = await this.call(
        id === undefined
          ? `repos/${this.config.repo}/issues/${this.config.issue}/comments`
          : `repos/${this.config.repo}/issues/comments/${id}`,
        id === undefined ? 'POST' : 'PATCH',
        body,
        signal,
      );
      const published = parseComment(reply.data);
      if (!published || published.sessionId !== session.sessionId)
        throw new Error('GitHub did not confirm presence publication');
      this.comments.set(session.sessionId, published.commentId);
      this.uncertain.delete(session.sessionId);
    } catch (error) {
      // An explicit 4xx rejects creation; transport failures and 5xx can hide a committed write.
      if (error instanceof PresenceApiError && error.status >= 400 && error.status < 500)
        this.uncertain.delete(session.sessionId);
      // A deleted comment is rediscovered or recreated on the next heartbeat, never blindly re-POSTed now.
      if (error instanceof PresenceApiError && error.status === 404) this.comments.delete(session.sessionId);
      throw error;
    }
  }
}

/** Persistent random ID for this data directory. Called while its daemon lifetime lock is held. */
export function presenceInstanceId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'instance-id');
  try {
    const id = readFileSync(path, 'utf8').trim();
    if (UUID.test(id)) return id;
    throw new Error('Invalid instance-id; remove it while the daemon is stopped');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const id = randomUUID();
    writeFileSync(path, `${id}\n`, { flag: 'wx', mode: 0o600 });
    return id;
  }
}

/** A serial heartbeat loop. Shutdown aborts its in-flight work before publishing the terminal state. */
export function watchPresence(
  config: PresenceConfig,
  session: () => PresenceSession,
  changed: (snapshot: PresenceSnapshot) => void,
  log: (message: string) => void,
): () => Promise<void> {
  const controller = new AbortController();
  const registry = new PresenceRegistry(config, githubRequest, controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let pending: Promise<void>;
  const tick = async () => {
    let snapshot = disabledPresence();
    try {
      // Read independently of write permission, so a publication failure cannot hide an existing peer.
      snapshot = await registry.read();
      if (!stopping) changed(snapshot);
      await registry.publish(session(), false);
    } catch (error) {
      if (!stopping)
        changed({
          ...snapshot,
          state: 'unknown',
          error: sanitize(error instanceof Error ? error.message : String(error)),
        });
    } finally {
      if (!stopping)
        timer = setTimeout(() => {
          pending = tick();
        }, HEARTBEAT_MS);
    }
  };
  pending = tick();
  return async () => {
    stopping = true;
    clearTimeout(timer);
    controller.abort();
    await pending;
    try {
      await registry.publish(session(), true, AbortSignal.timeout(4_000));
    } catch {
      log(
        'could not publish stopped presence; other machines will mark this session stale after its last heartbeat expires',
      );
    }
  };
}
