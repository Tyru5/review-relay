import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('info resolves custom reviewer executables and JSON commands keep warnings on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        port: 1,
        dataDir: dir,
        repos: [{ fullName: 'o/r', localPath: dir }],
        reviewers: ['haiku'],
        models: { haiku: { harness: 'claude' }, codex: { unknown: 'ignored' } },
      }),
    );
    for (const args of [['info'], ['info', '--json'], ['config']]) {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args, '--config', config],
        {
          env: { ...process.env, PATH: dir, NO_COLOR: '1' },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toContain('warning:');
      const output = result.stdout.toString();
      if (args.length === 1 && args[0] === 'info') {
        expect(output).toContain('haiku');
        expect(output).toContain('on claude');
        expect(output).toContain('claude not on PATH');
      } else {
        expect(JSON.parse(output).models.haiku.harness).toBe('claude');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
