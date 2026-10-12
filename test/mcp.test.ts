import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { execOrThrow } from '../src/exec.ts';
import { createMcpServer, PROTOCOL_VERSIONS, TOOLS, type McpDeps } from '../src/mcp.ts';
import { DIMENSIONS, type Verdict } from '../src/verdict.ts';

const root = mkdtempSync(join(tmpdir(), 'relay-mcp-'));
// Owns the seeded running jobs: a job recorded with this test's own pid but not queued by it reads as orphaned.
const owner = Bun.spawn(['sleep', '600']);
afterAll(() => {
  owner.kill();
  rmSync(root, { recursive: true, force: true });
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const verdict = (findings: Verdict['findings']): Verdict => ({
  summary: 'Adds b.txt.',
  score: 4,
  scoreRationale: 'Small.',
  dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 4, note: 'ok' }])) as Verdict['dimensions'],
  findings,
});

const finding = (title: string, line: number) => ({
  severity: 'minor' as const,
  file: 'b.txt',
  line,
  title,
  detail: 'd',
  suggestion: 's',
});

/** A data dir holding one finished PR review with a report from two reviewers, and one running local review. */
function seeded(name: string) {
  const dir = join(root, name);
  const reportDir = join(dir, 'reports', 'o__r', 'pr-7', 'aaaaaaaa');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify([
      {
        key: 'o/r@bbbbbbbb22:local',
        repo: 'o/r',
        pr: 0,
        headSha: 'bbbbbbbb22',
        source: 'local',
        status: 'running',
        startedAt: ago(1_000),
        pid: owner.pid,
        branch: 'feature',
        base: 'origin/main',
      },
      {
        key: 'o/r@aaaaaaaa11',
        repo: 'o/r',
        pr: 7,
        headSha: 'aaaaaaaa11',
        source: 'github',
        status: 'done',
        startedAt: ago(600_000),
        finishedAt: ago(300_000),
        reportDir,
      },
    ]),
  );
  writeFileSync(
    join(reportDir, 'meta.json'),
    JSON.stringify({
      score: 3,
      reviewers: [
        { name: 'claude', harness: 'claude', ok: true, score: 4, durationMs: 1000 },
        { name: 'codex', harness: 'codex', ok: true, score: 3, durationMs: 2000 },
        { name: 'gemini', harness: 'gemini', ok: false, error: 'timed out', durationMs: 3000 },
      ],
    }),
  );
  writeFileSync(join(reportDir, 'claude.json'), JSON.stringify({ score: 4, verdict: verdict([finding('Same', 3)]) }));
  writeFileSync(
    join(reportDir, 'codex.json'),
    JSON.stringify({ score: 3, verdict: verdict([finding('Same', 4), finding('Other', 40)]) }),
  );
  return dir;
}

/** A server whose replies are collected; the config comes from `config`, or loading it fails when that is null. */
function server(config: unknown, overrides: Partial<McpDeps> = {}) {
  const sent: any[] = [];
  const deps: McpDeps = {
    version: '9.9.9',
    configPath: '/nowhere/config.json',
    cwd: root,
    loadConfig: async () => {
      if (config === null) throw new Error('no config at /nowhere/config.json');
      return parseConfig(config);
    },
    spawn: () => {
      throw new Error('spawn not expected');
    },
    prHead: async () => {
      throw new Error('prHead not expected');
    },
    isAlive: () => true,
    commandLine: () => null,
    log: () => {},
    pollMs: 10,
    ...overrides,
  };
  const mcp = createMcpServer(deps, (message) => sent.push(message));
  let id = 0;
  const call = async (method: string, params?: unknown) => {
    const n = ++id;
    await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
    return sent.find((m) => m.id === n);
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await call('tools/call', { name, arguments: args })).result;
  return { mcp, sent, call, tool };
}

const configFor = (dataDir: string) => ({ dataDir, repos: [{ fullName: 'o/r', localPath: dataDir }] });

describe('protocol', () => {
  test('initialize agrees on a version the client knows and offers tools', async () => {
    const { call } = server(null);
    const known = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {} });
    expect(known.result.protocolVersion).toBe('2025-03-26');
    expect(known.result.capabilities).toEqual({ tools: {} });
    expect(known.result.serverInfo).toMatchObject({ name: 'review-relay', version: '9.9.9' });
    const future = await call('initialize', { protocolVersion: '2099-01-01' });
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  test('lists every tool with a schema and no handler', async () => {
    const { call } = server(null);
    const { result } = await call('tools/list');
    expect(result.tools.map((t: any) => t.name)).toEqual(['review_branch', 'review_pr', 'get_review', 'list_reviews']);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.call).toBeUndefined();
    }
  });

  test('answers ping, rejects unknown methods and tools, and never answers a notification', async () => {
    const { mcp, sent, call } = server(null);
    expect((await call('ping')).result).toEqual({});
    expect((await call('resources/list')).error.code).toBe(-32601);
    expect((await call('tools/call', { name: 'nope' })).error.code).toBe(-32602);
    const before = sent.length;
    await mcp.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }));
    await mcp.handle('');
    expect(sent.length).toBe(before);
    await mcp.handle('{not json');
    expect(sent.at(-1)).toMatchObject({ id: null, error: { code: -32700 } });
  });

  test('a missing config or a bad argument is a failed tool call, not a protocol error', async () => {
    const missing = await server(null).tool('list_reviews');
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('no config at');
    const bad = await server(configFor(seeded('bad-args'))).tool('list_reviews', { limit: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('limit must be a whole number from 1 to 100');
    const status = await server(configFor(seeded('bad-status'))).tool('list_reviews', { status: 'completed' });
    expect(status.isError).toBe(true);
    expect(status.content[0].text).toBe('status must be one of queued, running, done, failed, skipped, superseded');
  });

  test('answers a batch with one array of replies, and a batch of notifications with nothing', async () => {
    const { mcp, sent } = server(null);
    await mcp.handle(
      JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', id: 'b', method: 'nope' },
      ]),
    );
    expect(sent).toEqual([
      [
        { jsonrpc: '2.0', id: 'a', result: {} },
        { jsonrpc: '2.0', id: 'b', error: { code: -32601, message: 'method not found: nope' } },
      ],
    ]);
    await mcp.handle(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
    expect(sent.length).toBe(1);
    await mcp.handle('[]');
    expect(sent.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  test('a cancelled call stops waiting and gets no reply', async () => {
    const { mcp, sent } = server(configFor(seeded('cancel')));
    const waiting = mcp.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_review', arguments: { key: 'o/r@bbbbbbbb22:local', waitSeconds: 600 } },
      }),
    );
    await Bun.sleep(30);
    await mcp.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
    await waiting;
    expect(sent.find((m) => m.id === 1)).toBeUndefined();
  });
});

describe('reading reviews', () => {
  test('list_reviews lists jobs newest first with their scores, and filters them', async () => {
    const { tool } = server(configFor(seeded('list')));
    const all = (await tool('list_reviews')).structuredContent;
    expect(all.total).toBe(2);
    expect(all.jobs.map((j: any) => j.key)).toEqual(['o/r@bbbbbbbb22:local', 'o/r@aaaaaaaa11']);
    expect(all.jobs[0]).toMatchObject({ branch: 'feature', base: 'origin/main', status: 'running', score: null });
    expect(all.jobs[1]).toMatchObject({
      pr: 7,
      status: 'done',
      score: 3,
      findings: { critical: 0, major: 0, minor: 2 },
    });
    const done = (await tool('list_reviews', { status: 'done' })).structuredContent;
    expect(done.jobs.map((j: any) => j.pr)).toEqual([7]);
    expect((await tool('list_reviews', { pr: 8 })).structuredContent.total).toBe(0);
  });

  test('get_review returns the merged findings and each reviewer, by key or by PR', async () => {
    const { tool } = server(configFor(seeded('get')));
    const byKey = (await tool('get_review', { key: 'o/r@aaaaaaaa11' })).structuredContent;
    expect(byKey).toMatchObject({ pr: 7, status: 'done', score: 3, findingCounts: { minor: 2 } });
    expect(byKey.findings).toEqual([
      { ...finding('Same', 3), reviewers: ['claude', 'codex'] },
      { ...finding('Other', 40), reviewers: ['codex'] },
    ]);
    expect(byKey.reviewers).toEqual([
      expect.objectContaining({ name: 'claude', ok: true, score: 4, summary: 'Adds b.txt.', scoreRationale: 'Small.' }),
      expect.objectContaining({ name: 'codex', ok: true, score: 3 }),
      expect.objectContaining({ name: 'gemini', ok: false, error: 'timed out' }),
    ]);
    const byPr = (await tool('get_review', { repo: 'O/R', pr: 7 })).structuredContent;
    expect(byPr.key).toBe('o/r@aaaaaaaa11');
    const newest = (await tool('get_review')).structuredContent;
    expect(newest).toMatchObject({ key: 'o/r@bbbbbbbb22:local', status: 'running' });
    expect((await tool('get_review', { repo: 'o/r', pr: 8 })).content[0].text).toBe('no review of o/r#8 yet');
    expect((await tool('get_review', { repo: 'o/r' })).content[0].text).toBe('pass repo and pr together');
  });
});

describe('starting reviews', () => {
  test('review_pr starts `run` for the PR head and reports the job once it is recorded', async () => {
    const dataDir = seeded('pr');
    const spawned: string[][] = [];
    const { tool } = server(configFor(dataDir), {
      configPath: '/c.json',
      prHead: async (repo, pr) => {
        expect([repo, pr]).toEqual(['o/r', 9]);
        return 'cccccccc33';
      },
      spawn: (dir, args) => {
        spawned.push(args);
        // Stands in for the background `run` recording the job.
        const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
        state.unshift({
          key: 'o/r@cccccccc33',
          repo: 'o/r',
          pr: 9,
          headSha: 'cccccccc33',
          source: 'manual',
          status: 'queued',
          startedAt: new Date().toISOString(),
          pid: owner.pid,
        });
        writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
        return 4242;
      },
    });
    const result = (await tool('review_pr', { repo: 'o/r', pr: 9 })).structuredContent;
    expect(spawned).toEqual([
      [
        'run',
        '--config',
        '/c.json',
        '--repo',
        'o/r',
        '--pr',
        '9',
        '--head',
        'cccccccc33',
        '--spawn-id',
        expect.stringMatching(/^[0-9a-f]{16}$/),
      ],
    ]);
    expect(result).toMatchObject({ key: 'o/r@cccccccc33', pr: 9, status: 'queued', posts: true });
  });

  test('review_pr refuses an unknown repo or route, and quotes only its own process when that dies first', async () => {
    const dataDir = seeded('pr-errors');
    const log = join(dataDir, 'daemon.log');
    writeFileSync(log, 'error: an earlier failure\n');
    const { tool } = server(configFor(dataDir), {
      prHead: async () => 'dddddddd44',
      spawn: (_dir, args) => {
        const mark = ` [mcp:${args.at(-1)}]`;
        // The daemon restarts, another review fails, and the daemon reviews the same PR, while the process fails.
        writeFileSync(
          log,
          [
            'error: an earlier failure',
            'review-relay  v0.11.0  pid 99',
            '  endpoint    http://127.0.0.1:9988/hook',
            '✖ another review failed [mcp:0123456789abcdef]',
            '10:00:00 [o/r] PR #1 @ aaaaaaaa: reviewing',
            `warning: config warning from the process${mark}`,
            `10:00:01 [o/r] PR #1 failed before review: gh not signed in${mark}`,
            '',
          ].join('\n'),
        );
        return 1;
      },
      isAlive: () => false,
    });
    expect((await tool('review_pr', { repo: 'x/y', pr: 1 })).content[0].text).toContain('no configured repo named');
    expect((await tool('review_pr', { repo: 'o/r', pr: 1, route: 'nope' })).content[0].text).toContain(
      'no route named "nope"',
    );
    const died = await tool('review_pr', { repo: 'o/r', pr: 1 });
    expect(died.isError).toBe(true);
    expect(died.content[0].text).toBe(
      [
        'the review process exited before it recorded the job:',
        'warning: config warning from the process',
        '10:00:01 [o/r] PR #1 failed before review: gh not signed in',
      ].join('\n'),
    );
  });

  test('starting a commit again replaces an earlier start that died unrecorded instead of failing', async () => {
    const dead = new Set<number>();
    const spawned: string[][] = [];
    const { tool } = server(configFor(seeded('restart')), {
      prHead: async () => 'abababab77',
      spawn: (_dir, args) => {
        spawned.push(args);
        return 5000 + spawned.length;
      },
      isAlive: (pid) => !dead.has(pid),
      startWaitMs: 20,
    });
    expect((await tool('review_pr', { repo: 'o/r', pr: 4 })).structuredContent.status).toBe('starting');
    dead.add(5001);
    const again = await tool('review_pr', { repo: 'o/r', pr: 4 });
    expect(again.isError).toBeUndefined();
    expect(again.structuredContent).toMatchObject({ key: 'o/r@abababab77', status: 'starting' });
    expect(again.structuredContent.alreadyRunning).toBeUndefined();
    expect(spawned.length).toBe(2);
  });

  test('a start whose pid now belongs to another process counts as exited', async () => {
    let cmd: string | null = null;
    const { tool } = server(configFor(seeded('reused')), {
      prHead: async () => 'cdcdcdcd88',
      spawn: () => 6001,
      startWaitMs: 20,
      pidCheckMs: 0,
      commandLine: () => cmd,
    });
    expect((await tool('review_pr', { repo: 'o/r', pr: 4 })).structuredContent.status).toBe('starting');
    // Unreadable: the live pid is trusted.
    expect((await tool('get_review', { key: 'o/r@cdcdcdcd88' })).structuredContent.status).toBe('starting');
    cmd = '/usr/bin/vim notes.txt';
    const gone = await tool('get_review', { key: 'o/r@cdcdcdcd88', waitSeconds: 5 });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain('the review process exited before it recorded the job');
  });

  test('a process that marks no lines, like an older CLI, gets the unattributed lines written meanwhile', async () => {
    const dataDir = seeded('unmarked');
    const log = join(dataDir, 'daemon.log');
    writeFileSync(log, 'error: an earlier failure\n');
    const { tool } = server(configFor(dataDir), {
      prHead: async () => 'dededede99',
      spawn: () => {
        writeFileSync(
          log,
          [
            'error: an earlier failure',
            '10:00:00 [o/r] PR #1 @ aaaaaaaa: reviewing',
            '✖ another review failed [mcp:0123456789abcdef]',
            `✖ Unknown option '--spawn-id'`,
            '',
          ].join('\n'),
        );
        return 1;
      },
      isAlive: () => false,
    });
    const died = await tool('review_pr', { repo: 'o/r', pr: 1 });
    expect(died.isError).toBe(true);
    expect(died.content[0].text).toBe(
      `the review process exited before it recorded the job; it logged nothing of its own, but these unattributed lines reached ${log} meanwhile:\n✖ Unknown option '--spawn-id'`,
    );
  });

  test('a process that never started fails at once', async () => {
    const { tool } = server(configFor(seeded('no-pid')), { prHead: async () => 'eeeeeeee55', spawn: () => 0 });
    const result = await tool('review_pr', { repo: 'o/r', pr: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not start the review process');
  });

  test('a job not recorded yet stays starting, and get_review waits for it by key or by PR', async () => {
    const dataDir = seeded('slow-start');
    let alive = true;
    const { tool } = server(configFor(dataDir), {
      prHead: async () => 'ffffffff66',
      spawn: () => 4343,
      isAlive: () => alive,
      startWaitMs: 30,
    });
    const started = (await tool('review_pr', { repo: 'o/r', pr: 7, waitSeconds: 0 })).structuredContent;
    expect(started).toEqual({ key: 'o/r@ffffffff66', status: 'starting', posts: true });
    // The PR's earlier, finished review is not its latest any more.
    expect((await tool('get_review', { repo: 'o/r', pr: 7 })).structuredContent.status).toBe('starting');
    expect((await tool('get_review')).structuredContent.key).toBe('o/r@ffffffff66');

    const waiting = tool('get_review', { key: 'o/r@ffffffff66', waitSeconds: 10 });
    await Bun.sleep(50);
    const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
    const record = (status: string) => ({
      key: 'o/r@ffffffff66',
      repo: 'o/r',
      pr: 7,
      headSha: 'ffffffff66',
      source: 'manual',
      status,
      startedAt: new Date().toISOString(),
      ...(status === 'done' ? { finishedAt: new Date().toISOString() } : { pid: owner.pid }),
    });
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify([record('running'), ...state]));
    await Bun.sleep(50);
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify([record('done'), ...state]));
    alive = false;
    expect((await waiting).structuredContent).toMatchObject({ key: 'o/r@ffffffff66', status: 'done' });
  });

  test('a commit already under review keeps its job, and says the requested route did not apply', async () => {
    const dataDir = seeded('already');
    const config = {
      ...configFor(dataDir),
      routes: [{ name: 'risky', when: { baseBranches: ['main'] }, reviewers: ['claude'] }],
    };
    const { tool } = server(config, { prHead: async () => 'bbbbbbbb22' });
    const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
    state.unshift({ ...state[0], key: 'o/r@bbbbbbbb22', pr: 5, source: 'github', branch: undefined, base: undefined });
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));
    const result = (await tool('review_pr', { repo: 'o/r', pr: 5, route: 'risky' })).structuredContent;
    expect(result).toMatchObject({ alreadyRunning: true, key: 'o/r@bbbbbbbb22', status: 'running' });
    expect(result.note).toContain("this call's route did not apply");
    expect(result.reviewerIds).toBeUndefined();
    const plain = (await tool('review_pr', { repo: 'o/r', pr: 5 })).structuredContent;
    expect(plain.note).toBeUndefined();
  });

  test('review_branch runs a background review end to end, and get_review waits for its findings', async () => {
    const git = (dir: string, ...args: string[]) =>
      execOrThrow(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    const origin = join(root, 'e2e.git');
    const checkout = join(root, 'e2e');
    const dataDir = join(root, 'e2e-data');
    await execOrThrow(['git', 'init', '--quiet', '--bare', '--initial-branch=main', origin]);
    await execOrThrow(['git', 'clone', '--quiet', origin, checkout]);
    await git(checkout, 'checkout', '--quiet', '-b', 'main');
    writeFileSync(join(checkout, 'a.txt'), 'a\n');
    await git(checkout, 'add', 'a.txt');
    await git(checkout, 'commit', '--quiet', '-m', 'base');
    await git(checkout, 'push', '--quiet', 'origin', 'main');
    await git(checkout, 'checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(checkout, 'b.txt'), 'b\n');
    await git(checkout, 'add', 'b.txt');
    await git(checkout, 'commit', '--quiet', '-m', 'add b');

    // A claude that answers every review with the same verdict.
    const bin = join(root, 'e2e-bin');
    mkdirSync(bin);
    const output = JSON.stringify({ type: 'result', structured_output: verdict([finding('Missing newline', 1)]) });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat <<'EOF'\n${output}\nEOF\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const configPath = join(root, 'e2e-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ dataDir, reviewers: ['claude'], repos: [{ fullName: 'acme/e2e', localPath: checkout }] }),
    );

    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'mcp', '--config', configPath], {
      cwd: checkout,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const replies = new Map<number, any>();
    const reader = (async () => {
      let buffer = '';
      for await (const chunk of proc.stdout) {
        buffer += new TextDecoder().decode(chunk);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.id !== undefined) replies.set(message.id, message);
        }
      }
    })();
    const request = async (id: number, method: string, params?: unknown) => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      proc.stdin.flush();
      while (!replies.has(id)) await Bun.sleep(20);
      return replies.get(id);
    };
    try {
      const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      expect(init.result.serverInfo.name).toBe('review-relay');
      const started = (await request(2, 'tools/call', { name: 'review_branch', arguments: {} })).result;
      expect(started.isError).toBeUndefined();
      const head = (await git(checkout, 'rev-parse', 'HEAD')).trim();
      expect(started.structuredContent).toMatchObject({
        key: `acme/e2e@${head}:local`,
        branch: 'feature',
        base: 'origin/main',
        commits: 1,
        reviewerIds: ['claude'],
      });
      // The fake reviewer answers at once, so the review may already be done.
      expect(['queued', 'running', 'done']).toContain(started.structuredContent.status);

      const done = (
        await request(3, 'tools/call', {
          name: 'get_review',
          arguments: { key: started.structuredContent.key, waitSeconds: 60 },
        })
      ).result.structuredContent;
      expect(done).toMatchObject({ status: 'done', score: 4, branch: 'feature' });
      expect(done.findings).toEqual([{ ...finding('Missing newline', 1), reviewers: ['claude'] }]);
      expect(done.reviewers).toEqual([expect.objectContaining({ name: 'claude', ok: true, summary: 'Adds b.txt.' })]);
    } finally {
      proc.stdin.end();
      await proc.exited;
      await reader;
    }
  }, 90_000);
});

test('every tool requires only what its handler requires', () => {
  const required = Object.fromEntries(TOOLS.map((t) => [t.name, (t.inputSchema.required as string[]) ?? []]));
  expect(required).toEqual({ review_branch: [], review_pr: ['repo', 'pr'], get_review: [], list_reviews: [] });
});
