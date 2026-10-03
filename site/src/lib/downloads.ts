import { createServerFn } from '@tanstack/react-start';

export const REPO = 'https://github.com/Tyru5/review-relay';
export const RELEASES = `${REPO}/releases`;
export const INSTALL_SH = `${RELEASES}/latest/download/install.sh`;
export const INSTALL_PS1 = `${RELEASES}/latest/download/install.ps1`;
export const checksumsUrl = (version: string) => `${RELEASES}/download/v${version}/SHA256SUMS`;

/** GitHub answers /releases/latest with a redirect to /releases/tag/<tag>; the tag is the version. */
export function versionFromLatestRedirect(location: string | null): string | null {
  const tag = location?.match(/\/releases\/tag\/v?([^/?#]+)/)?.[1];
  return tag && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(tag) ? tag : null;
}

/** The version the installers fetch by default, or null before the first release or if GitHub is unreachable. */
export const getLatestVersion = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const res = await fetch(`${RELEASES}/latest`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return versionFromLatestRedirect(res.headers.get('location'));
  } catch {
    return null;
  }
});
