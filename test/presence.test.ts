import { expect, test } from 'bun:test';
import { PresenceRegistry, presenceState, type PresenceRequest } from '../src/presence.ts';

const config = { repo: 'team/control', issue: 8, label: 'laptop' };
const now = Date.parse('2026-10-22T12:00:00Z');
const session = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  label: 'laptop',
  version: '0.12.5',
  repos: [{ name: 'team/app', state: 'standby' as const }],
};

/** The GitHub HTTP boundary, with comments persisted independently of each client. */
function github() {
  const comments: any[] = [];
  let time = now;
  let unavailable = false;
  let privateRepo = true;
  let loseWriteReply = false;
  const request: PresenceRequest = async (path, method = 'GET', body) => {
    if (unavailable) throw new Error('offline');
    let data: unknown;
    if (path === 'repos/team/control') data = { private: privateRepo };
    else if (method === 'POST') {
      data = {
        id: comments.length + 1,
        user: { login: 'alice' },
        body: body!.body,
        updated_at: new Date(time).toISOString(),
      };
      comments.push(data);
      if (loseWriteReply) {
        loseWriteReply = false;
        throw new Error('connection lost after write');
      }
    } else if (method === 'PATCH') {
      const comment = comments.find((c) => c.id === Number(path.split('/').at(-1)));
      Object.assign(comment, { body: body!.body, updated_at: new Date(time).toISOString() });
      data = comment;
    } else data = comments;
    return { data: structuredClone(data), serverTime: time };
  };
  return {
    comments,
    request,
    time: (t: number) => {
      time = t;
    },
    offline: () => {
      unavailable = true;
    },
    public: () => {
      privateRepo = false;
    },
    loseReply: () => {
      loseWriteReply = true;
    },
  };
}

test('two daemon sessions identify each other by GitHub author and expire by server time', async () => {
  const gh = github();
  const a = new PresenceRegistry(config, gh.request);
  const b = new PresenceRegistry(config, gh.request);
  await a.publish(session, false);
  await b.publish({ ...session, sessionId: '33333333-3333-4333-8333-333333333333', label: 'build-server' }, false);
  const seen = await a.read();
  expect(seen.state).toBe('ok');
  expect(seen.instances.map((i) => [i.label, i.account])).toEqual([
    ['laptop', 'alice'],
    ['build-server', 'alice'],
  ]);
  expect(presenceState(seen.instances[0]!, seen.serverTime!)).toBe('recent');
  gh.time(now + 180_000);
  const expired = await b.read();
  expect(presenceState(expired.instances[0]!, expired.serverTime!)).toBe('stale');
  await a.publish(session, true);
  const stopped = await b.read();
  expect(presenceState(stopped.instances[0]!, stopped.serverTime!)).toBe('stopped');
  expect(gh.comments).toHaveLength(2);
});

test('an ambiguous publish is reconciled instead of creating a second session comment', async () => {
  const gh = github();
  let hideComments = false;
  const registry = new PresenceRegistry(config, async (path, ...args) => {
    const reply = await gh.request(path, ...args);
    return hideComments && path.includes('?per_page=') ? { ...reply, data: [] } : reply;
  });
  gh.loseReply();
  await expect(registry.publish(session, false)).rejects.toThrow('connection lost');
  hideComments = true;
  await expect(registry.publish(session, false)).rejects.toThrow('uncertain');
  expect(gh.comments).toHaveLength(1);
  hideComments = false;
  await registry.publish(session, false);
  expect(gh.comments).toHaveLength(1);
});

test('a failed registry read is unknown, and a public registry never receives identity data', async () => {
  const gh = github();
  const registry = new PresenceRegistry(config, gh.request);
  gh.public();
  await expect(registry.publish(session, false)).rejects.toThrow('private');
  expect(gh.comments).toHaveLength(0);
  gh.offline();
  expect(await registry.read()).toMatchObject({ state: 'unknown', error: 'offline' });
});
