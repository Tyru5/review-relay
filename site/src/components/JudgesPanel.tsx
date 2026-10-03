import { headline, PR, verdicts } from '../lib/panel';

const PANEL = verdicts('minor');
const SCORE = headline(PANEL);
const RINGED = PANEL.findIndex((v) => v.score === SCORE);

const RAISE_AT = 250;
const RAISE_STEP = 140;
const RING_AT = RAISE_AT + RAISE_STEP * (PANEL.length - 1) + 650;
const LIGHT_AT = RING_AT + 450;
const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

const SEAT = 'flex flex-1 justify-center';
const CARD_WIDTH = 'w-full max-w-[8rem]';
const SEAT_GAP = 'gap-[clamp(0.75rem,3vw,2.5rem)] px-2 sm:px-6';

/** The judges' desk, played once on load: the judges raise their cards from behind it and the lowest is ringed. */
export function JudgesDesk() {
  return (
    <div role="img" aria-label={`Example panel: ${PANEL.map((v) => `${v.judge} ${v.score}/5`).join(', ')}`}>
      <div className={`relative flex overflow-hidden pt-8 ${SEAT_GAP}`}>
        {PANEL.map((v, i) => (
          <div key={v.judge} className={SEAT}>
            <div
              className={`judge-raise flex flex-col items-center ${CARD_WIDTH}`}
              style={delay(RAISE_AT + i * RAISE_STEP)}
            >
              <div className="relative grid aspect-[4/5] w-full place-items-center rounded-[10px] bg-paper text-navy">
                <span className="type-broadcast text-[clamp(4rem,8.5vw,6.75rem)] tabular-nums">{v.score}</span>
                {i === RINGED && <Ring />}
              </div>
              <div aria-hidden className="h-10 w-3 bg-paper-rule sm:h-12" />
            </div>
          </div>
        ))}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-3 bg-rule" />
      </div>
      <div aria-hidden className={`flex bg-arena-deep pt-3 pb-4 ${SEAT_GAP}`}>
        {PANEL.map((v) => (
          <span key={v.judge} className={SEAT}>
            <span
              className={`type-label border border-rule bg-board py-1.5 text-center text-xs text-chalk ${CARD_WIDTH}`}
            >
              {v.judge}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The result board: the PR on the panel and the score that counts, lit after the ring lands. */
export function ResultBoard() {
  return (
    <figure>
      <div className="rounded-xl bg-board p-5">
        <p className="font-mono text-xs text-haze">
          {PR.repo} #{PR.number}
        </p>
        <p className="mt-1 font-semibold">{PR.title}</p>
        <div className="mt-5 flex items-end gap-4 border-t border-rule pt-4">
          <p className="board-light type-led text-[5.5rem] text-gold" style={delay(LIGHT_AT)}>
            {SCORE}
            <span className="text-[2.5rem] text-haze">/5</span>
          </p>
          <div className="pb-2">
            <p className="type-label text-xs text-chalk">Merge confidence</p>
            <p className="mt-1 text-sm text-haze">
              Lowest of {PANEL.length} judges on <span className="font-mono text-[0.8rem]">{PR.commit}</span>
            </p>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-haze">
        Example panel on a fictional repo with three configured agents.
      </figcaption>
    </figure>
  );
}

/** The telestrator ring a broadcaster draws around the score that counts. Its box keeps the card's 4:5 ratio, so the stroke scales evenly. */
function Ring() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 118"
      preserveAspectRatio="none"
      className="pointer-events-none absolute top-[-12%] left-[-16%] h-[124%] w-[132%] overflow-visible"
    >
      <path
        d="M52 4C80 3 97 25 97 57c0 33-19 57-47 57C21 114 3 90 3 59 3 26 22 5 49 6c9 0 17 3 23 7"
        pathLength={1}
        fill="none"
        stroke="var(--color-gold)"
        strokeWidth="2.6"
        strokeLinecap="round"
        className="judge-ring"
        style={delay(RING_AT)}
      />
    </svg>
  );
}
