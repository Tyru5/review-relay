import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('separate machine sessions warn on startup, list authenticated identities, and publish shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-presence-cli-'));
  const comments: any[] = [];
  let offline = false;
  let limitedRequests = 0;
  // GitHub comment timestamps and HTTP Date both have whole-second precision.
  const updatedAt = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('x-test-account') === 'limited') {
        limitedRequests++;
        return Response.json({}, { status: 429, headers: { 'retry-after': '3600' } });
      }
      if (offline) return Response.json({ message: 'offline' }, { status: 503 });
      const path = new URL(request.url).pathname;
      if (path === '/repos/team/control') return Response.json({ private: true });
      if (request.method === 'POST') {
        const body = (await request.json()) as { body: string };
        const comment = {
          id: comments.length + 1,
          user: { login: request.headers.get('x-test-account') },
          body: body.body,
          updated_at: updatedAt(),
        };
        comments.push(comment);
        return Response.json(comment, { status: 201 });
      }
      if (request.method === 'PATCH') {
        const comment = comments.find((c) => c.id === Number(path.split('/').at(-1)));
        if (!comment) return Response.json({}, { status: 404 });
        Object.assign(comment, await request.json(), { updated_at: updatedAt() });
        return Response.json(comment);
      }
      return Response.json(comments);
    },
  });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    RELAY_TEST_GITHUB_URL: `http://127.0.0.1:${api.port}`,
    NO_COLOR: '1',
  };
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for daemon presence');
      await Bun.sleep(30);
    }
  };
  const run = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, error, code };
  };
  try {
    writeFileSync(
      join(root, 'gh'),
      `#!/usr/bin/env bun\nimport ${JSON.stringify(join(import.meta.dir, 'fixtures/presence-gh.ts'))};\n`,
    );
    chmodSync(join(root, 'gh'), 0o755);
    const configs: string[] = [];
    for (const label of ['laptop', 'build-server']) {
      const dir = join(root, label);
      mkdirSync(dir);
      const config = join(dir, 'config.json');
      writeFileSync(
        config,
        JSON.stringify({
          dataDir: dir,
          port: 0,
          reviewers: ['codex'],
          repos: [{ fullName: 'team/app', localPath: root, trigger: 'github' }],
          presence: { repo: 'team/control', issue: 8, label },
        }),
      );
      configs.push(config);
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'start', '--config', config], {
        env: { ...env, RELAY_TEST_ACCOUNT: label === 'laptop' ? 'alice' : 'bob' },
        stdout: Bun.file(join(dir, 'output')),
        stderr: Bun.file(join(dir, 'error')),
      });
      children.push(child);
      await until(() => comments.length === children.length);
    }
    await until(() => readFileSync(join(root, 'build-server/output'), 'utf8').includes('laptop'));
    const result = await run(['instances', '--config', configs[1]!, '--json']);
    expect(result.code).toBe(0);
    const snapshot = JSON.parse(result.out);
    expect(snapshot.instances.map((i: any) => [i.label, i.account])).toEqual([
      ['laptop', 'alice'],
      ['build-server', 'bob'],
    ]);
    expect(result.out).not.toContain(root);
    expect(result.out).not.toContain('--secret');
    const recordPath = join(root, 'build-server/daemon.json');
    const record = readFileSync(recordPath, 'utf8');
    // port: 0 selects another free HTTP port; only the data-directory lock prevents this duplicate.
    const duplicate = await run(['start', '--config', configs[1]!]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.error).toContain('locked');
    expect(readFileSync(recordPath, 'utf8')).toBe(record);
    children[0]!.kill('SIGTERM');
    await children[0]!.exited;
    expect(comments[0].body).toContain('"stopped":true');
    offline = true;
    const unknown = await run(['instances', '--config', configs[1]!, '--json']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.out).state).toBe('unknown');
    // A killed daemon leaves a forwarder behind. The CLI must reap it before removing the record.
    children[1]!.kill('SIGKILL');
    await children[1]!.exited;
    const recovered = await run(['stop', '--config', configs[1]!]);
    expect(recovered.code).toBe(0);
    expect(recovered.out).toContain('forwarder groups verified stopped');
    expect(existsSync(recordPath)).toBe(false);
    offline = false;
    const limitedOutput = join(root, 'limited-output');
    const limited = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../src/cli.ts'), 'start', '--config', configs[1]!],
      {
        env: { ...env, RELAY_TEST_ACCOUNT: 'limited' },
        stdout: Bun.file(limitedOutput),
        stderr: 'ignore',
      },
    );
    children.push(limited);
    await until(() => readFileSync(limitedOutput, 'utf8').includes('HTTP 429'));
    limited.kill('SIGTERM');
    await limited.exited;
    expect(limitedRequests).toBe(1); // publishing and shutdown both honor the read's backoff
    expect(comments).toHaveLength(2);
  } finally {
    offline = false;
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.map((c) => c.exited));
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
