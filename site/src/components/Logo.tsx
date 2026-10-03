export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M6 27h15M8.5 35h7" stroke="var(--color-relay)" strokeWidth="5" />
      <path d="M22 35l9.5 9.5L55 21M43 19h12v12" stroke="var(--color-go)" strokeWidth="7" />
    </svg>
  );
}
