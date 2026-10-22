import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';

/** Kernel-owned lifetime lock. No stale file can be unlinked underneath another contender.
 * Hash collisions (or a foreign listener) fail closed. This is independent of the HTTP port.
 */
export async function acquireDaemonLock(dataDir: string): Promise<() => Promise<void>> {
  mkdirSync(dataDir, { recursive: true });
  let path = realpathSync(dataDir);
  if (process.platform === 'win32') path = path.toLowerCase();
  const hash = createHash('sha256').update(path).digest();
  const port = 16384 + (hash.readUInt32BE(0) % 16384);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(new Error('Daemon data directory is already locked (or its lock port is occupied)')),
    );
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

export const secretHash = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function signalTree(pid: number, sig: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
    } else process.kill(-pid, sig);
  } catch {
    /* Already gone, or not permitted; caller checks survivors. */
  }
}

export interface Member {
  pid: number;
  group: number;
  args: string[] | null;
}

/** Ambiguous command lines fail closed; Linux exposes lossless argv directly. */
function splitArgs(command: string): string[] | null {
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  if (!tokens || tokens.join(' ') !== command.trim().replace(/\s+/g, ' ')) return null;
  return tokens.map((s) => (/^['"]/.test(s) ? s.slice(1, -1) : s));
}

/** null means enumeration failed, not an empty process table. Zombies hold no sockets. */
export function processMembers(): Member[] | null {
  try {
    if (process.platform === 'win32') {
      const out = Bun.spawnSync(
        [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      if (!out.success) return null;
      const parsed = JSON.parse(out.stdout.toString());
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: p.ProcessId,
        group: p.ParentProcessId,
        args: p.CommandLine ? splitArgs(p.CommandLine) : null,
      }));
    }
    const out = Bun.spawnSync(['ps', '-eo', 'pid=,pgid=,stat=,args='], { stdout: 'pipe', stderr: 'ignore' });
    if (!out.success) return null;
    return out.stdout
      .toString()
      .split('\n')
      .flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m || m[3]!.startsWith('Z')) return [];
        const pid = Number(m[1]);
        let args: string[] | null = null;
        try {
          args =
            process.platform === 'linux'
              ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
              : splitArgs(m[4]!);
        } catch {
          /* Cannot verify this process. */
        }
        return [{ pid, group: Number(m[2]), args }];
      });
  } catch {
    return null;
  }
}

export function matchesForwarder(
  args: string[] | null,
  repo: string,
  events: string,
  port: number,
  hash: string,
): boolean {
  if (!args) return false;
  const forward = args.indexOf('forward');
  if (forward < 1 || !(args[forward - 1] === 'webhook' || /(?:^|[\\/])gh-webhook(?:\.exe)?$/.test(args[forward - 1]!)))
    return false;
  const flags = args.slice(forward + 1);
  const value = (name: string) => {
    const found: string[] = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === name) found.push(flags[++i] ?? '');
      else if (flags[i]!.startsWith(`${name}=`)) found.push(flags[i]!.slice(name.length + 1));
    }
    return found.length === 1 ? found[0] : undefined;
  };
  const secret = value('--secret');
  return (
    value('--repo') === repo &&
    value('--events') === events &&
    value('--url') === `http://127.0.0.1:${port}/hook` &&
    secret !== undefined &&
    secretHash(secret) === hash
  );
}
