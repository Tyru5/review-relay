import type { ReactNode } from 'react';

/** Command names, paths, and identifiers inside prose. */
export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.88em] text-ink">{children}</code>;
}

/** Terminal lines with a non-selectable prompt, so copying a selection yields runnable commands. */
export function CommandBlock({ lines, prompt = '$' }: { lines: string[]; prompt?: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-line bg-surface px-4 py-3 font-mono text-[0.84rem] leading-relaxed text-ink">
      {lines.map((line) => (
        <span key={line} className="block">
          <span className="text-muted select-none">{prompt} </span>
          {line}
        </span>
      ))}
    </pre>
  );
}
