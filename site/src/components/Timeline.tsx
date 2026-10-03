import type { CSSProperties, ReactNode } from 'react';

/** Signal colors: relay = in flight, go = landed, quiet = not yet happening. */
export type Signal = 'relay' | 'go' | 'quiet';

const DOT: Record<Signal, string> = {
  relay: 'bg-relay',
  go: 'bg-go',
  quiet: 'border border-line bg-night',
};

/** A vertical rail of events, the shape of a PR timeline. Used for the sample review and the review steps. */
export function Timeline({
  children,
  rail = 'quiet',
  railClassName = '',
  railStyle,
  className = '',
}: {
  children: ReactNode;
  rail?: Signal;
  railClassName?: string;
  railStyle?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={`relative pl-7 ${className}`}>
      <div
        aria-hidden
        className={`absolute top-2.5 bottom-3 left-[5px] w-0.5 ${rail === 'quiet' ? 'bg-line' : rail === 'go' ? 'bg-go/60' : 'bg-relay/60'} ${railClassName}`}
        style={railStyle}
      />
      {children}
    </div>
  );
}

export function TimelineDot({
  signal,
  className = '',
  style,
}: {
  signal: Signal;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span aria-hidden className={`absolute -left-7 size-3 rounded-full ${DOT[signal]} ${className}`} style={style} />
  );
}
