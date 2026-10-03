import { COPY_LABEL, PLATFORMS, useInstallCommand } from '../lib/install';

export function Install() {
  const { platform, setPlatform, copy, copyCommand, commandRef, command, prompt } = useInstallCommand();

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div role="tablist" aria-label="Operating system" className="flex gap-1 border-b border-line p-1.5">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`tab-${p.id}`}
            aria-selected={platform === p.id}
            aria-controls="install-command"
            onClick={() => setPlatform(p.id)}
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
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[0.78rem] whitespace-nowrap text-ink">
          <span className="text-muted select-none">{prompt} </span>
          <span ref={commandRef}>{command}</span>
        </code>
        <button
          type="button"
          onClick={copyCommand}
          className={`w-[5.25rem] shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors duration-300 ${
            copy === 'copied' ? 'border-go/50 text-go' : 'border-line text-ink hover:border-muted hover:bg-raised'
          }`}
        >
          <span aria-live="polite">{COPY_LABEL[copy]}</span>
        </button>
      </div>
    </div>
  );
}
