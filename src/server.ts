import { createHmac, timingSafeEqual } from 'node:crypto';
import { findRepo, type Config } from './config.ts';
import { classify } from './match.ts';
import type { Scheduler } from './scheduler.ts';

export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Routes one GitHub delivery to the scheduler. Shared by the HTTP server and `replay`. */
export function routeEvent(config: Config, scheduler: Scheduler, event: string, payload: any, log = console.log): void {
  const repo = findRepo(config, payload?.repository?.full_name);
  if (!repo) return;
  const result = classify(event, payload, repo.github);
  if (result.kind === 'ignore') {
    if (process.env.REVIEW_RELAY_DEBUG) log(`[${repo.fullName}] ignored: ${result.reason}`);
    return;
  }
  scheduler.handle(repo, result);
}

export function startServer(config: Config, scheduler: Scheduler, secret: string) {
  return Bun.serve({
    port: config.port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') return new Response('ok');
      if (req.method !== 'POST' || url.pathname !== '/hook') return new Response('not found', { status: 404 });
      const body = await req.text();
      if (!verifySignature(secret, body, req.headers.get('x-hub-signature-256'))) {
        return new Response('bad signature', { status: 401 });
      }
      const event = req.headers.get('x-github-event') ?? '';
      try {
        routeEvent(config, scheduler, event, JSON.parse(body));
      } catch (err) {
        console.error(`failed to handle ${event}:`, err);
      }
      return new Response('ok');
    },
  });
}
