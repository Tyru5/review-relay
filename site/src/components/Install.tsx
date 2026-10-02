import { useEffect, useState } from 'react';
import { DOWNLOADS } from '../lib/downloads';

const PLATFORMS = [
  { id: 'unix', label: 'macOS / Linux', command: `curl -fsSL ${DOWNLOADS}/install.sh | bash` },
  { id: 'windows', label: 'Windows', command: `irm ${DOWNLOADS}/install.ps1 | iex` },
] as const;

type PlatformId = (typeof PLATFORMS)[number]['id'];

export function Install() {
  const [platform, setPlatform] = useState<PlatformId>('unix');
  const [copied, setCopied] = useState(false);
  const { command } = PLATFORMS.find((p) => p.id === platform)!;

  // Detected after hydration so the server and first client render agree.
  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setPlatform('windows');
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  return (
    <div className="rounded-xl border border-line bg-surface/90 backdrop-blur-sm">
      <div role="tablist" aria-label="Operating system" className="flex gap-1 border-b border-line p-1.5">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`tab-${p.id}`}
            aria-selected={platform === p.id}
            aria-controls="install-command"
            onClick={() => {
              setPlatform(p.id);
              setCopied(false);
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-ink aria-selected:bg-raised aria-selected:text-ink"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        id="install-command"
        role="tabpanel"
        aria-labelledby={`tab-${platform}`}
        className="flex items-center gap-3 py-3 pr-3 pl-4"
      >
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[0.8rem] whitespace-nowrap text-ink">
          <span className="text-muted select-none">{platform === 'windows' ? '> ' : '$ '}</span>
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-go hover:text-go"
        >
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}
