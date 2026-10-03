import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A local clone of a GitHub repo: what a `repos[]` config entry needs. */
export interface Clone {
  /** `owner/name` from the clone's origin remote. */
  fullName: string;
  /** Absolute path of the clone. */
  localPath: string;
}

/** Folders never descended into while looking for clones: dependency trees and build output, which are large and hold no clones of the user's own. */
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'Library']);

/** How many folder levels under each root `discoverClones` looks: `~/code/org/repo` and `~/Documents/x/y/repo` both fit. */
export const SCAN_DEPTH = 4;

/** `owner/name` from a GitHub remote URL in any of the forms git accepts, or undefined for other hosts. */
export function parseGithubRemote(url: string): string | undefined {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/]+@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The origin remote's URL from a clone's `.git/config`, or undefined when `dir` is not a clone (a worktree's `.git` file counts as not). */
export function originUrl(dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, '.git', 'config'), 'utf8');
  } catch {
    return undefined;
  }
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url && /^remote\s+"origin"$/.test(section)) return url[1];
  }
  return undefined;
}

/** The clone at `dir` when its origin is on GitHub. */
export function cloneAt(dir: string): Clone | undefined {
  const url = originUrl(dir);
  const fullName = url && parseGithubRemote(url);
  return fullName ? { fullName, localPath: dir } : undefined;
}

/**
 * GitHub clones under `roots`, up to `depth` levels down, sorted by name. Hidden folders and dependency trees are
 * skipped, and a clone's own subfolders aren't searched (nested clones would need their own entry anyway).
 */
export function discoverClones(roots = [homedir()], depth = SCAN_DEPTH): Clone[] {
  const found: Clone[] = [];
  const walk = (dir: string, level: number) => {
    const clone = cloneAt(dir);
    if (clone) return found.push(clone);
    if (level >= depth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Symlinks are not directories to readdir, so a link into another tree is never followed.
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) {
        walk(join(dir, entry.name), level + 1);
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return found.toSorted((a, b) => a.fullName.localeCompare(b.fullName) || a.localPath.localeCompare(b.localPath));
}
