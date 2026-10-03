type LogoProps = { className?: string; cue?: string; check?: string };

export function Logo({ className, cue = 'var(--color-relay)', check = 'var(--color-go)' }: LogoProps) {
  return (
    <svg viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M6 27h15M8.5 35h7" stroke={cue} strokeWidth="5" />
      <path d="M22 35l9.5 9.5L55 21M43 19h12v12" stroke={check} strokeWidth="7" />
    </svg>
  );
}
