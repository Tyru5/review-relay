import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportDirFor } from '../src/report.ts';
import type { JobRecord } from '../src/state.ts';
import { fmtDuration, renderStatus } from '../src/status.ts';

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

const finding = (severity: string, line: number) => ({
  severity,
  file: 'a.ts',
  line,
  title: 't',
  detail: 'd',
  suggestion: 's',
});

function writeFixtureReport(dataDir: string, job: JobRecord) {
  const dir = reportDirFor(dataDir, job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      score: 3,
      reviewers: [
        { name: 'codex', ok: true, score: 4, durationMs: 65_000 },
        { name: 'claude', ok: false, error: 'timed out after 1800s', durationMs: 1_800_000 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'codex.json'),
    JSON.stringify({ score: 4, verdict: { findings: [finding('major', 3), finding('minor', 40)] } }),
  );
}

describe('renderStatus', () => {
  test('header titles each column and rows read scores, timings, and findings from the report', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-status-'));
    const done = record('aaaaaaaa11');
    writeFixtureReport(dataDir, done);
    const running = record('bbbbbbbb22', {
      status: 'running',
      startedAt: '2026-10-02T10:10:00.000Z',
      finishedAt: undefined,
    });

    const [header, runRow, doneRow] = renderStatus([running, done], {
      dataDir,
      reviewers: ['codex', 'claude'],
      color: false,
      now: Date.parse('2026-10-02T10:10:30.000Z'),
    });

    expect(header!.split(/\s{2,}/)).toEqual([
      'STATUS',
      'STARTED',
      'TIME',
      'REPO',
      'PR',
      'COMMIT',
      'SOURCE',
      'SCORE',
      'CODEX',
      'CLAUDE',
      'CRIT',
      'MAJ',
      'MIN',
      'NOTE',
    ]);
    expect(runRow).toContain('running');
    expect(runRow).toContain('30s');
    expect(doneRow).toMatch(
      /2m05s\s+o\/r\s+#7\s+aaaaaaaa\s+github\s+3\/5\s+4\/5 1m05s\s+failed 30m00s\s+0\s+1\s+1\s+claude: timed out/,
    );
  });

  test('shows the route each job took, and a skipped job with no scores', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-status-'));
    const routed = record('aaaaaaaa11', { route: 'risky' });
    writeFixtureReport(dataDir, routed);
    const skipped = record('dddddddd44', { status: 'skipped', route: 'docs', startedAt: '2026-10-02T10:20:00.000Z' });
    const [header, skipRow, routedRow] = renderStatus([skipped, routed], {
      dataDir,
      reviewers: ['codex', 'claude'],
      color: false,
    });
    expect(header).toMatch(/SOURCE\s+ROUTE\s+SCORE/);
    expect(skipRow).toMatch(/^skipped\s.*dddddddd\s+github\s+docs\s+-\s+-\s+-\s+-\s+-\s+-/);
    expect(routedRow).toMatch(/aaaaaaaa\s+github\s+risky\s+3\/5/);
    // Without routes the column goes away, as it did before routing existed.
    const [plain] = renderStatus([record('aaaaaaaa11')], { dataDir, reviewers: ['codex'], color: false });
    expect(plain).not.toContain('ROUTE');
  });

  test('drops NOTE when no job has an error', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-status-'));
    const [header] = renderStatus([record('cccccccc33')], { dataDir, reviewers: ['codex'], color: false });
    expect(header).not.toContain('NOTE');
  });
});

test('fmtDuration', () => {
  expect(fmtDuration(4_400)).toBe('4s');
  expect(fmtDuration(919_423)).toBe('15m19s');
  expect(fmtDuration(3_900_000)).toBe('1h05m');
});
