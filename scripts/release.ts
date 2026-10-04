#!/usr/bin/env bun
/**
 * Builds standalone review-relay binaries and publishes them as a GitHub Release. `dist/v<version>/`
 * holds exactly the release assets:
 *
 *   review-relay-<os>-<arch>[.exe]   binaries
 *   SHA256SUMS                       checked by the installers
 *   config.example.json              seeded as ~/.review-relay/config.json
 *   install.sh, install.ps1          installers, fetched from releases/latest/download/
 *
 * Usage: bun scripts/release.ts [--skip-upload]
 * Uploads use `gh`: `gh auth login` locally, the workflow's GITHUB_TOKEN in CI. The `v<version>` tag
 * must already be pushed and point at HEAD; an existing release is never modified.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { version } from '../package.json';
import { exec, execOrThrow } from '../src/exec.ts';

export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;
export type Target = (typeof TARGETS)[number];

export const REPO = process.env.GITHUB_REPOSITORY ?? 'Tyru5/review-relay';
const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

export const assetName = (target: Target) => `review-relay-${target}${target.startsWith('windows') ? '.exe' : ''}`;

/** Every file attached to the release, in upload order. */
export const releaseAssets = (): string[] => [
  ...TARGETS.map(assetName),
  'SHA256SUMS',
  'config.example.json',
  'install.sh',
  'install.ps1',
];

/** `sha256sum`-compatible lines, so `sha256sum -c SHA256SUMS` works on a download directory. */
export function sha256sums(files: Record<string, Uint8Array>): string {
  return Object.entries(files)
    .map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
    .join('');
}

/** A `-rc.1` style suffix marks a pre-release, so `releases/latest` keeps pointing at the last stable one. */
export const isPrerelease = (ver: string) => ver.includes('-');

/**
 * Binaries are only published from the commit their tag points at, and only to a new release: replacing assets
 * on a live one deletes each before its upload lands, so installs in between, or after an interrupted run, find
 * a missing binary or a SHA256SUMS that no longer matches.
 */
export function assertPublishable(
  tag: string,
  { head, tagCommit, released }: { head: string; tagCommit: string; released: boolean },
) {
  if (tagCommit !== head) {
    throw new Error(
      `tag ${tag} points at ${tagCommit.slice(0, 7)}, not HEAD ${head.slice(0, 7)}; ` +
        `publish from the tag: git checkout ${tag}, or gh workflow run release.yml --ref ${tag}`,
    );
  }
  if (released) throw new Error(`release ${tag} is already published; bump the version to ship new binaries`);
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
  copyFileSync(join(ROOT, 'scripts/install.sh'), join(dir, 'install.sh'));
  copyFileSync(join(ROOT, 'scripts/install.ps1'), join(dir, 'install.ps1'));
  return dir;
}

/** HEAD, the commit `tag` points at on REPO, and whether REPO already has a published release for it. */
async function publishState(tag: string) {
  const head = (await execOrThrow(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })).trim();
  const tagged = await exec(['gh', 'api', `repos/${REPO}/commits/tags/${tag}`, '--jq', '.sha']);
  if (tagged.code !== 0)
    throw new Error(`could not resolve tag ${tag} on ${REPO}; is it pushed? ${tagged.stderr.trim()}`);
  const released = (await exec(['gh', 'api', `repos/${REPO}/releases/tags/${tag}`, '--silent'])).code === 0;
  return { head, tagCommit: tagged.stdout.trim(), released };
}

async function publish(dir: string) {
  const tag = `v${version}`;
  const files = releaseAssets().map((name) => join(dir, name));
  // gh uploads into a draft and publishes it once every asset is in, so installers never see a partial release.
  console.log(`creating release ${tag}`);
  await execOrThrow([
    'gh',
    'release',
    'create',
    tag,
    ...files,
    '--repo',
    REPO,
    '--verify-tag',
    '--title',
    tag,
    '--generate-notes',
    ...(isPrerelease(version) ? ['--prerelease'] : []),
  ]);
}

async function main() {
  const { values } = parseArgs({ options: { 'skip-upload': { type: 'boolean', default: false } } });

  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`tag ${process.env.GITHUB_REF_NAME} does not match package.json version v${version}`);
  }
  if (!values['skip-upload'] && (await execOrThrow(['git', 'status', '--porcelain'], { cwd: ROOT })).trim()) {
    throw new Error('working tree has changes; commit them or pass --skip-upload');
  }
  if (!values['skip-upload']) assertPublishable(`v${version}`, await publishState(`v${version}`));

  const dir = await build();
  console.log(`staged v${version} in ${dir}`);
  if (values['skip-upload']) return;
  await publish(dir);
  console.log(`published v${version}: https://github.com/${REPO}/releases/tag/v${version}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
