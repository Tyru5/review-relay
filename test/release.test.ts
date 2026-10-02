import { expect, test } from 'bun:test';
import { assetName, sha256sums, TARGETS, uploadPlan } from '../scripts/release.ts';

test('assetName adds .exe only for Windows', () => {
  expect(assetName('linux-x64')).toBe('review-relay-linux-x64');
  expect(assetName('darwin-arm64')).toBe('review-relay-darwin-arm64');
  expect(assetName('windows-x64')).toBe('review-relay-windows-x64.exe');
});

test('sha256sums writes sha256sum -c compatible lines', () => {
  expect(sha256sums({ a: new TextEncoder().encode('abc') })).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a\n',
  );
});

test('uploadPlan publishes every binary immutably and flips latest.txt last', () => {
  const plan = uploadPlan('1.2.3');
  for (const t of TARGETS) {
    expect(plan).toContainEqual(
      expect.objectContaining({ key: `v1.2.3/${assetName(t)}`, cacheControl: expect.stringContaining('immutable') }),
    );
  }
  expect(plan.at(-1)).toEqual(expect.objectContaining({ key: 'latest.txt', cacheControl: 'no-cache' }));
  const index = (key: string) => plan.findIndex((u) => u.key === key);
  expect(index('v1.2.3/SHA256SUMS')).toBeLessThan(index('install.sh'));
  expect(new Set(plan.map((u) => u.key)).size).toBe(plan.length);
});
