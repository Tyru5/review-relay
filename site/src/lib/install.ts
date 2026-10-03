import { useEffect, useRef, useState } from 'react';
import { DOWNLOADS } from './downloads';

export const PLATFORMS = [
  { id: 'unix', label: 'macOS / Linux', prompt: '$', command: `curl -fsSL ${DOWNLOADS}/install.sh | bash` },
  { id: 'windows', label: 'Windows', prompt: '>', command: `irm ${DOWNLOADS}/install.ps1 | iex` },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]['id'];
export type CopyState = 'idle' | 'copied' | 'selected';

export const COPY_LABEL: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', selected: 'Selected' };

/** Install command state shared by every install control: OS detection, copy, and the clipboard fallback. */
export function useInstallCommand() {
  const [platform, setPlatformState] = useState<PlatformId>('unix');
  const [copy, setCopy] = useState<CopyState>('idle');
  const commandRef = useRef<HTMLSpanElement>(null);
  const current = PLATFORMS.find((p) => p.id === platform)!;

  // Detected after hydration so the server and first client render agree.
  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setPlatformState('windows');
  }, []);

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  const setPlatform = (id: PlatformId) => {
    setPlatformState(id);
    setCopy('idle');
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(current.command);
      setCopy('copied');
    } catch {
      // Clipboard access can be blocked; select the command so a keyboard copy still works.
      const node = commandRef.current;
      if (node) window.getSelection()?.selectAllChildren(node);
      setCopy('selected');
    }
  };

  return { platform, setPlatform, copy, copyCommand, commandRef, ...current };
}
