export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
}

/** Runs a binary directly (no shell, so user aliases and functions never apply). */
export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5_000).unref();
      }, opts.timeoutMs)
    : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

export async function execOrThrow(cmd: string[], opts: ExecOptions = {}): Promise<string> {
  const result = await exec(cmd, opts);
  if (result.code !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(' ')} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}
