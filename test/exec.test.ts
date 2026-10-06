import { expect, test } from 'bun:test';
import { exec } from '../src/exec.ts';

test('aborting the signal kills the process without calling it a timeout', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const run = exec(['sleep', '10'], { signal: controller.signal, timeoutMs: 60_000 });
  setTimeout(() => controller.abort('newer'), 50);
  const result = await run;
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.code).not.toBe(0);
  expect(result.timedOut).toBe(false);
});

test('a signal aborted before the spawn kills the process at once', async () => {
  const started = Date.now();
  const result = await exec(['sleep', '10'], { signal: AbortSignal.abort('newer') });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.code).not.toBe(0);
});
