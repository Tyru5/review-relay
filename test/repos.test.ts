import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneAt, discoverClones, originUrl, parseGithubRemote } from '../src/repos.ts';

describe('parseGithubRemote', () => {
  test('reads owner/name from every URL form git accepts for GitHub', () => {
    for (const url of [
      'git@github.com:acme/app.git',
      'git@github.com:acme/app',
      'ssh://git@github.com/acme/app.git',
      'https://github.com/acme/app.git',
      'https://github.com/acme/app',
      'https://github.com/acme/app/',
      'https://user@github.com/acme/app.git',
      'git://github.com/acme/app.git',
      ' HTTPS://GitHub.com/acme/app.git\n',
    ]) {
      expect(parseGithubRemote(url)).toBe('acme/app');
    }
    expect(parseGithubRemote('git@github.com:acme/my.repo-2.git')).toBe('acme/my.repo-2');
  });

  test('ignores other hosts and malformed paths', () => {
    expect(parseGithubRemote('git@gitlab.com:acme/app.git')).toBeUndefined();
    expect(parseGithubRemote('https://github.com/acme')).toBeUndefined();
    expect(parseGithubRemote('https://github.com/acme/app/extra')).toBeUndefined();
    expect(parseGithubRemote('https://github.com.evil.com/acme/app')).toBeUndefined();
    expect(parseGithubRemote('/home/u/app')).toBeUndefined();
  });
});

/** Writes a fake clone at `dir`: a `.git/config` whose origin is `url`. */
function fakeClone(dir: string, url: string, extra = '') {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    `[core]\n\tbare = false\n${extra}[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`,
  );
}

describe('clones on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-repos-'));
  fakeClone(join(root, 'code', 'app'), 'git@github.com:acme/app.git');
  fakeClone(join(root, 'code', 'app', 'nested'), 'git@github.com:acme/nested.git');
  fakeClone(join(root, 'Documents', 'ti', 'lib'), 'https://github.com/acme/lib');
  fakeClone(join(root, 'code', 'elsewhere'), 'git@gitlab.com:acme/elsewhere.git');
  fakeClone(join(root, 'node_modules', 'dep'), 'git@github.com:acme/dep.git');
  fakeClone(join(root, '.cache', 'hidden'), 'git@github.com:acme/hidden.git');
  fakeClone(join(root, 'a', 'b', 'c', 'd', 'deep'), 'git@github.com:acme/deep.git');
  mkdirSync(join(root, 'wt'), { recursive: true });
  writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');
  symlinkSync(join(root, 'code'), join(root, 'link'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  test('originUrl reads the origin remote and not another one', () => {
    expect(originUrl(join(root, 'code', 'app'))).toBe('git@github.com:acme/app.git');
    expect(originUrl(join(root, 'code'))).toBeUndefined();
    expect(originUrl(join(root, 'wt'))).toBeUndefined();
  });

  test('cloneAt pairs the folder with its GitHub repo', () => {
    expect(cloneAt(join(root, 'Documents', 'ti', 'lib'))).toEqual({
      fullName: 'acme/lib',
      localPath: join(root, 'Documents', 'ti', 'lib'),
    });
    expect(cloneAt(join(root, 'code', 'elsewhere'))).toBeUndefined();
    expect(cloneAt(join(root, 'missing'))).toBeUndefined();
  });

  test('discoverClones finds GitHub clones to the scan depth, skipping hidden, dependency, nested, and linked folders', () => {
    expect(discoverClones([root])).toEqual([
      { fullName: 'acme/app', localPath: join(root, 'code', 'app') },
      { fullName: 'acme/lib', localPath: join(root, 'Documents', 'ti', 'lib') },
    ]);
    expect(discoverClones([root], 5).map((c) => c.fullName)).toEqual(['acme/app', 'acme/deep', 'acme/lib']);
    expect(discoverClones([join(root, 'nope')])).toEqual([]);
    cleanup();
  });
});
