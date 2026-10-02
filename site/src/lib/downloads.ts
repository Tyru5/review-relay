import { createServerFn } from '@tanstack/react-start';

export const DOWNLOADS = 'https://downloads.reviewrelay.dev';

/** The version the installers fetch by default, or null before the first release or if the CDN is unreachable. */
export const getLatestVersion = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const res = await fetch(`${DOWNLOADS}/latest.txt`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const version = (await res.text()).trim();
    return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
  } catch {
    return null;
  }
});
