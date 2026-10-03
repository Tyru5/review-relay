import { COPY_LABEL, PLATFORMS, useInstallCommand } from '../lib/install';

type Tone = 'arena' | 'gold';

const TAB_BLOCK: Record<Tone, string> = {
  arena: 'bg-gold text-navy',
  gold: 'bg-navy text-chalk',
};
const TAB_SELECTED: Record<Tone, string> = {
  arena: 'aria-selected:bg-navy aria-selected:text-gold',
  gold: 'aria-selected:bg-gold aria-selected:text-navy',
};

/** The install command as a broadcast lower third: an OS tab block, the command bar, and Copy. */
export function LowerThird({ id, tone = 'arena' }: { id: string; tone?: Tone }) {
  const { platform, setPlatform, copy, copyCommand, commandRef, command, prompt } = useInstallCommand();
  const panelId = `${id}-command`;

  return (
    <div className="flex w-full flex-col sm:flex-row">
      <div role="tablist" aria-label="Operating system" className={`flex shrink-0 gap-1 p-1.5 ${TAB_BLOCK[tone]}`}>
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`${id}-tab-${p.id}`}
            aria-selected={platform === p.id}
            aria-controls={panelId}
            onClick={() => setPlatform(p.id)}
            className={`type-label flex-1 px-3 py-2 text-[0.8rem] transition-colors hover:bg-black/10 sm:flex-none ${TAB_SELECTED[tone]}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${platform}`}
        className="on-paper flex min-w-0 flex-1 items-center gap-3 bg-paper py-2 pr-2 pl-4 text-navy"
      >
        <code className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-[0.8rem] whitespace-nowrap">
          <span className="text-slate select-none">{prompt} </span>
          <span ref={commandRef}>{command}</span>
        </code>
        <button
          type="button"
          onClick={copyCommand}
          className="type-label flex w-[6.5rem] shrink-0 items-center justify-center gap-1.5 bg-navy px-3 py-2.5 text-[0.8rem] text-chalk transition-colors hover:bg-arena"
        >
          {copy === 'copied' && <CheckIcon />}
          <span aria-live="polite">{COPY_LABEL[copy]}</span>
        </button>
      </div>
    </div>
  );
}

export function CheckIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M3 8.5l3.2 3L13 4.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
