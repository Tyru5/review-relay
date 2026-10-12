import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, pricesFor } from '../src/config.ts';
import { renderCosts, renderSpend, reviewCosts, spend } from '../src/cost.ts';
import { reportDirFor } from '../src/report.ts';
import type { JobRecord } from '../src/state.ts';
import { readReport, renderStatus } from '../src/status.ts';
import { styles } from '../src/ui.ts';
import {
  addCost,
  estimateCost,
  fmtCost,
  fmtTokens,
  fmtUsage,
  priced,
  readUsage,
  totalCost,
  type Usage,
} from '../src/usage.ts';

const tokens = (patch: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 100_000,
  ...patch,
});

describe('pricing', () => {
  test('prices fresh input, cache reads, cache writes, and output at their own rates', () => {
    const price = { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 };
    // 1M input: 600k fresh, 300k cached, 100k written; 100k output.
    const usage = tokens({ cachedInputTokens: 300_000, cacheWriteTokens: 100_000 });
    expect(estimateCost(usage, price)).toBeCloseTo(6 + 0.3 + 1.25 + 5, 10);
    // Cached and written input cost the input rate when the price leaves them out.
    expect(estimateCost(usage, { input: 10, output: 50 })).toBeCloseTo(10 + 5, 10);
  });

  test("keeps a CLI's own cost, estimates a priced model, and leaves an unpriced one without a cost", () => {
    const prices = pricesFor(parseConfig({ repos: [{ fullName: 'o/r', localPath: '/tmp' }] }));
    expect(priced(tokens({ costUsd: 1.5 }), 'gpt-6-astra', prices)).toMatchObject({
      costUsd: 1.5,
      costSource: 'reported',
    });
    expect(priced(tokens(), 'gpt-6-astra', prices)).toMatchObject({ costUsd: 15, costSource: 'estimated' });
    expect(priced(tokens(), 'gpt-6-pro', prices).costUsd).toBeUndefined();
    expect(priced(tokens(), undefined, prices).costUsd).toBeUndefined();
  });

  test('config pricing adds models and overrides built-in prices, and rejects malformed ones', () => {
    const repos = [{ fullName: 'o/r', localPath: '/tmp' }];
    const config = parseConfig({
      repos,
      pricing: { 'gpt-6-pro': { input: 30, output: 180 }, 'gpt-6-astra': { input: 5, output: 25 } },
    });
    expect(config.pricing['gpt-6-pro']).toEqual({ input: 30, output: 180 });
    const prices = pricesFor(config);
    expect(prices['gpt-6-astra']).toEqual({ input: 5, output: 25 });
    expect(prices['gpt-6-luna']).toBeDefined();
    expect(parseConfig({ repos }).pricing).toEqual({});

    const fails = (pricing: unknown) => expect(() => parseConfig({ repos, pricing }));
    fails([]).toThrow('pricing must be an object');
    fails({ m: 3 }).toThrow('pricing.m must be an object');
    fails({ m: { input: 1 } }).toThrow('pricing.m needs both input and output');
    fails({ m: { input: 1, output: -1 } }).toThrow('pricing.m.output must be dollars per million tokens');
    fails({ m: { input: '1', output: 2 } }).toThrow('pricing.m.input must be dollars');
    fails({ m: { input: 1, output: 2, cached: 1 } }).toThrow('pricing.m.cached is not a price');
  });
});

describe('formatting and totals', () => {
  test('formats dollars, tokens, and the marks for estimated and partial costs', () => {
    expect(fmtCost({ costUsd: 1.844 })).toBe('$1.84');
    expect(fmtCost({ costUsd: 0.62, estimated: true, partial: true })).toBe('~$0.62+');
    expect(fmtCost({ costUsd: 0.001 })).toBe('<$0.01');
    expect(fmtCost({ costUsd: 0 })).toBe('$0.00');
    expect([850, 412_345, 999_499, 999_500, 1_234_567, 2_000_000].map(fmtTokens)).toEqual([
      '850',
      '412k',
      '999k',
      '1M',
      '1.2M',
      '2M',
    ]);
    expect(fmtUsage(tokens({ costUsd: 0.62, costSource: 'estimated' }))).toBe('~$0.62 · 1M in/100k out');
    expect(fmtUsage(tokens())).toBe('1M in/100k out');
  });

  test('totals only known costs, and says when part of the spend is missing or estimated', () => {
    const reported = tokens({ costUsd: 1, costSource: 'reported' });
    const estimated = tokens({ costUsd: 0.5, costSource: 'estimated' });
    expect(totalCost([reported, estimated])).toEqual({ costUsd: 1.5, estimated: true, partial: false });
    expect(totalCost([reported, tokens(), undefined])).toEqual({ costUsd: 1, estimated: false, partial: true });
    expect(totalCost([tokens(), undefined])).toBeNull();
    expect(addCost(null, null)).toBeNull();
    expect(addCost({ costUsd: 1, estimated: false, partial: false }, null)).toEqual({
      costUsd: 1,
      estimated: false,
      partial: false,
    });
  });

  test('reads usage back from a report, ignoring malformed fields', () => {
    expect(readUsage(undefined)).toBeUndefined();
    expect(readUsage('x')).toBeUndefined();
    expect(readUsage({ inputTokens: 5, outputTokens: 'x', costUsd: 0.2, costSource: 'estimated' })).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: 0.2,
      costSource: 'estimated',
    });
  });
});

const record = (sha: string, patch: Partial<JobRecord> = {}): JobRecord => ({
  key: `o/r@${sha}`,
  repo: 'o/r',
  pr: 7,
  headSha: sha,
  source: 'github',
  status: 'done',
  startedAt: '2026-10-02T10:00:00.000Z',
  finishedAt: '2026-10-02T10:02:05.000Z',
  ...patch,
});

const CLAUDE = {
  inputTokens: 412_000,
  cachedInputTokens: 300_000,
  cacheWriteTokens: 50_000,
  outputTokens: 12_000,
  costUsd: 1.84,
  costSource: 'reported',
};
const CODEX = {
  inputTokens: 288_000,
  cachedInputTokens: 200_000,
  cacheWriteTokens: 0,
  outputTokens: 9_000,
  costUsd: 0.62,
  costSource: 'estimated',
};

function writeMeta(dataDir: string, job: JobRecord, reviewers: Record<string, unknown>[]) {
  const dir = reportDirFor(dataDir, job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ score: 4, reviewers }));
}

/** Three finished reviews (both priced; codex timed out; from before usage was recorded), plus a running one. */
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-cost-'));
  const both = record('aaaaaaaa11', { startedAt: '2026-10-03T10:00:00.000Z' });
  const timedOut = record('bbbbbbbb22', { pr: 8, startedAt: '2026-10-02T10:00:00.000Z' });
  const old = record('cccccccc33', { pr: 9, startedAt: '2026-10-01T10:00:00.000Z' });
  const running = record('dddddddd44', { status: 'running', finishedAt: undefined });
  const skipped = record('eeeeeeee55', { status: 'skipped' });
  writeMeta(dataDir, both, [
    { name: 'codex', harness: 'codex', model: 'gpt-6-astra', ok: true, score: 4, durationMs: 1, usage: CODEX },
    { name: 'claude', harness: 'claude', model: 'claude-opus-5-5', ok: true, score: 4, durationMs: 1, usage: CLAUDE },
  ]);
  writeMeta(dataDir, timedOut, [
    {
      name: 'codex',
      harness: 'codex',
      model: 'gpt-6-pro',
      ok: false,
      durationMs: 1,
      usage: { ...CODEX, costUsd: undefined },
    },
    { name: 'claude', harness: 'claude', ok: true, score: 4, durationMs: 1, usage: CLAUDE },
  ]);
  writeMeta(dataDir, old, [{ name: 'codex', ok: true, score: 5, durationMs: 1 }]);
  return {
    dataDir,
    records: [running, both, timedOut, old, skipped],
    cleanup: () => rmSync(dataDir, { recursive: true }),
  };
}

describe('cost report', () => {
  test('lists finished reviews with each reviewer’s cost and tokens, and totals them', () => {
    const { dataDir, records, cleanup } = fixture();
    try {
      const reviews = reviewCosts(records, dataDir);
      // The running and skipped jobs have no report, so no cost.
      expect(reviews.map((r) => r.job.headSha)).toEqual(['aaaaaaaa11', 'bbbbbbbb22', 'cccccccc33']);
      expect(reviews.map((r) => r.total && fmtCost(r.total))).toEqual(['~$2.46', '$1.84+', null]);

      const [header, ...rows] = renderCosts(reviews, { reviewers: ['claude', 'codex'], color: false });
      expect(header!.split(/\s{2,}/)).toEqual(['STARTED', 'REPO', 'PR', 'COMMIT', 'CLAUDE', 'CODEX', 'TOTAL']);
      expect(rows[0]).toContain('$1.84 · 412k in/12k out  ~$0.62 · 288k in/9k out  ~$2.46');
      expect(rows[1]).toContain('$1.84 · 412k in/12k out  288k in/9k out');
      expect(rows[1]).toEndWith('$1.84+');
      expect(rows[2]).toMatch(/#9\s+cccccccc\s+-\s+-\s+-$/);

      const total = spend(reviews, ['claude', 'codex']);
      expect(total.reviews).toBe(3);
      expect(total.cost).toEqual({ costUsd: expect.closeTo(4.3, 10), estimated: true, partial: true });
      expect(total.reviewers.map((r) => [r.name, r.reviews, r.cost && fmtCost(r.cost), r.inputTokens])).toEqual([
        ['claude', 2, '$3.68', 824_000],
        ['codex', 3, '~$0.62+', 576_000],
      ]);
      expect(total.unpriced).toEqual(['gpt-6-pro']);

      const text = renderSpend(total, styles(false)).join('\n');
      expect(text).toMatch(/total\s+~\$4\.30\+\s+3 reviews \(2 with a cost\) · ~\$2\.15\+ per review/);
      expect(text).toMatch(/claude\s+\$3\.68\s+2 reviews · 824k in\/24k out/);
      expect(text).toMatch(/codex\s+~\$0\.62\+\s+3 reviews · 576k in\/18k out/);
      expect(text).toContain('~ estimated');
      expect(text).toContain('+ at least this much');
      expect(text).toContain('no price for gpt-6-pro; add it under pricing in the config');
    } finally {
      cleanup();
    }
  });

  test('prices usage recorded without a cost with the prices given now, keeping recorded costs as they were', () => {
    const { dataDir, records, cleanup } = fixture();
    try {
      const prices = { 'gpt-6-pro': { input: 1, output: 10 }, 'gpt-6-astra': { input: 100, output: 100 } };
      const [both, timedOut] = reviewCosts(records, dataDir, prices);
      // gpt-6-pro had no price when it ran: 288k in at $1/M and 9k out at $10/M.
      expect(timedOut!.reviewers[0]!.usage).toMatchObject({ costUsd: 0.288 + 0.09, costSource: 'estimated' });
      expect(timedOut!.total).toEqual({ costUsd: expect.closeTo(1.84 + 0.378, 10), estimated: true, partial: false });
      // The astra run was priced when it ran, so a new price leaves it alone.
      expect(both!.reviewers[0]!.usage?.costUsd).toBe(0.62);
      expect(spend(reviewCosts(records, dataDir, prices), []).unpriced).toEqual([]);

      const summary = readReport(reportDirFor(dataDir, records[2]!), prices);
      expect(summary?.cost?.partial).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('averages over the reviews that have a cost', () => {
    const { dataDir, records, cleanup } = fixture();
    try {
      const reviews = reviewCosts([records[1]!, records[3]!], dataDir);
      const total = spend(reviews, []);
      expect([total.reviews, total.costed, total.average?.costUsd]).toEqual([2, 1, expect.closeTo(2.46, 10)]);
      expect(renderSpend(total, styles(false)).join('\n')).toMatch(/2 reviews \(1 with a cost\) · ~\$2\.46 per review/);
      expect(spend([], []).average).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('says so when nothing has finished', () => {
    expect(renderCosts([], { reviewers: [], color: false })).toEqual(['no finished reviews yet']);
  });

  test('status shows a COST column once a job has a cost, and leaves it out otherwise', () => {
    const { dataDir, records, cleanup } = fixture();
    try {
      const summary = readReport(reportDirFor(dataDir, records[1]!));
      expect(summary?.cost).toEqual({ costUsd: expect.closeTo(2.46, 10), estimated: true, partial: false });
      const [header, , row] = renderStatus(records, { dataDir, reviewers: ['claude', 'codex'], color: false });
      expect(header).toMatch(/CLAUDE\s+CODEX\s+COST\s+CRIT/);
      expect(row).toContain('~$2.46');

      const [oldHeader] = renderStatus([records[3]!], { dataDir, reviewers: ['codex'], color: false });
      expect(oldHeader).not.toContain('COST');

      // A reviewer whose column shares a header with COST or ROUTE keeps it when those columns are dropped.
      writeMeta(dataDir, records[3]!, [
        { name: 'cost', ok: true, score: 5, durationMs: 1000 },
        { name: 'route', ok: true, score: 4, durationMs: 2000 },
      ]);
      const [named, namedRow] = renderStatus([records[3]!], { dataDir, reviewers: ['cost', 'route'], color: false });
      expect(named!.split(/\s{2,}/)).toEqual(
        'STATUS STARTED TIME REPO PR COMMIT SOURCE SCORE COST ROUTE CRIT MAJ MIN'.split(' '),
      );
      expect(namedRow).toMatch(/5\/5 1s\s+4\/5 2s\s+0\s+0\s+0$/);
    } finally {
      cleanup();
    }
  });
});
