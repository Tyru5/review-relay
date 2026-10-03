import { expect, test } from 'bun:test';
import { assetName, isPrerelease, releaseAssets, sha256sums, TARGETS } from '../scripts/release.ts';

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

test('releaseAssets attaches every binary, the checksums the installers verify, and the installers', () => {
  const assets = releaseAssets();
  for (const t of TARGETS) expect(assets).toContain(assetName(t));
  expect(assets).toContain('SHA256SUMS');
  expect(assets).toContain('config.example.json');
  expect(assets).toContain('install.sh');
  expect(assets).toContain('install.ps1');
  expect(new Set(assets).size).toBe(assets.length);
});

test('isPrerelease keys off a semver suffix', () => {
  expect(isPrerelease('1.2.3')).toBe(false);
  expect(isPrerelease('1.2.3-rc.1')).toBe(true);
});
