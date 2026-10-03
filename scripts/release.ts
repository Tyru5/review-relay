#!/usr/bin/env bun
/**
 * Builds standalone review-relay binaries and publishes them to the R2 bucket served at
 * https://downloads.reviewrelay.dev. `dist/` is staged with the bucket's layout:
 *
 *   v<version>/review-relay-<os>-<arch>[.exe]   immutable binaries
 *   v<version>/SHA256SUMS                       checked by the installers
 *   v<version>/config.example.json              seeded as ~/.review-relay/config.json
 *   install.sh, install.ps1                     installers for the latest release
 *   latest.txt                                  latest version, uploaded last
 *
 * Usage: bun scripts/release.ts [--skip-upload]
 * Uploads use wrangler: OAuth login locally, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in CI.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { execOrThrow } from '../src/exec.ts';

export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;
export type Target = (typeof TARGETS)[number];

const BUCKET = process.env.R2_BUCKET ?? 'review-relay-downloads';
const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

export const assetName = (target: Target) => `review-relay-${target}${target.startsWith('windows') ? '.exe' : ''}`;

/** `sha256sum`-compatible lines, so `sha256sum -c SHA256SUMS` works on a download directory. */
export function sha256sums(files: Record<string, Uint8Array>): string {
  return Object.entries(files)
    .map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
    .join('');
}

export interface Upload {
  key: string;
  contentType: string;
  cacheControl: string;
}

/** Versioned objects first, then the installers, then the `latest.txt` pointer that makes them live. */
export function uploadPlan(ver: string): Upload[] {
  const dir = `v${ver}`;
  return [
    ...TARGETS.map((t) => ({
      key: `${dir}/${assetName(t)}`,
      contentType: 'application/octet-stream',
      cacheControl: IMMUTABLE,
    })),
    { key: `${dir}/config.example.json`, contentType: 'application/json', cacheControl: IMMUTABLE },
    { key: `${dir}/SHA256SUMS`, contentType: 'text/plain; charset=utf-8', cacheControl: IMMUTABLE },
    { key: 'install.sh', contentType: 'text/plain; charset=utf-8', cacheControl: REVALIDATE },
    { key: 'install.ps1', contentType: 'text/plain; charset=utf-8', cacheControl: REVALIDATE },
    { key: 'latest.txt', contentType: 'text/plain; charset=utf-8', cacheControl: REVALIDATE },
  ];
}

function hostTarget(): Target | undefined {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform as string];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch as string];
  return TARGETS.find((t) => t === `${os}-${arch}`);
}

async function build() {
  const dir = join(DIST, `v${version}`);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const binaries: Record<string, Uint8Array> = {};
  for (const target of TARGETS) {
    const name = assetName(target);
    console.log(`building ${name}`);
    await execOrThrow(
      ['bun', 'build', '--compile', '--minify', `--target=bun-${target}`, 'src/cli.ts', '--outfile', join(dir, name)],
      { cwd: ROOT },
    );
    binaries[name] = readFileSync(join(dir, name));
  }

  const host = hostTarget();
  if (host) {
    const reported = (await execOrThrow([join(dir, assetName(host)), '--version'])).trim();
    if (reported !== version)
      throw new Error(`${assetName(host)} --version printed "${reported}", expected ${version}`);
  }

  writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(binaries));
  copyFileSync(join(ROOT, 'config.example.json'), join(dir, 'config.example.json'));
  copyFileSync(join(ROOT, 'scripts/install.sh'), join(DIST, 'install.sh'));
  copyFileSync(join(ROOT, 'scripts/install.ps1'), join(DIST, 'install.ps1'));
  writeFileSync(join(DIST, 'latest.txt'), `${version}\n`);
}

async function upload() {
  for (const { key, contentType, cacheControl } of uploadPlan(version)) {
    console.log(`uploading ${BUCKET}/${key}`);
    await execOrThrow([
      'bunx',
      'wrangler@4',
      'r2',
      'object',
      'put',
      `${BUCKET}/${key}`,
      '--remote',
      '--file',
      join(DIST, key),
      '--content-type',
      contentType,
      '--cache-control',
      cacheControl,
    ]);
  }
}

async function main() {
  const { values } = parseArgs({ options: { 'skip-upload': { type: 'boolean', default: false } } });

  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`tag ${process.env.GITHUB_REF_NAME} does not match package.json version v${version}`);
  }
  if (!values['skip-upload'] && (await execOrThrow(['git', 'status', '--porcelain'], { cwd: ROOT })).trim()) {
    throw new Error('working tree has changes; commit them or pass --skip-upload');
  }

  await build();
  console.log(`staged v${version} in ${DIST}`);
  if (values['skip-upload']) return;
  await upload();
  console.log(`published v${version}: https://downloads.reviewrelay.dev/install.sh`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
