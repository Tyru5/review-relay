---
name: review-relay
description: Your agents judge every pull request. The lowest score counts.
colors:
  arena: "#1d2b8f"
  arena-deep: "#131d6b"
  board: "#0a1040"
  rule: "#3d4ca3"
  gold: "#f2b705"
  gold-deep: "#a87a00"
  red: "#c42020"
  chalk: "#ffffff"
  haze: "#b8c2f2"
  paper: "#f6f5f0"
  paper-rule: "#d9d8e6"
  navy: "#0e1440"
  slate: "#4a5180"
typography:
  display:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.1rem, 6.4vw, 5.25rem)"
    fontWeight: 850
    lineHeight: 0.92
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 66"
  display-close:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.25rem, 9vw, 6rem)"
    fontWeight: 850
    lineHeight: 0.92
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 66"
  headline:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 5.5vw, 4.25rem)"
    fontWeight: 850
    lineHeight: 0.92
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 66"
  title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.9rem"
    fontWeight: 850
    lineHeight: 0.92
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 66"
  score:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(4rem, 8.5vw, 6.75rem)"
    fontWeight: 850
    lineHeight: 0.92
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 66"
  led:
    fontFamily: "Doto Variable, ui-monospace, monospace"
    fontSize: "5.5rem"
    fontWeight: 900
    lineHeight: 1
    fontFeature: "'tnum'"
  led-row:
    fontFamily: "Doto Variable, ui-monospace, monospace"
    fontSize: "4rem"
    fontWeight: 900
    lineHeight: 1
    fontFeature: "'tnum'"
  body-lede:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 700
    letterSpacing: "0.04em"
    fontVariation: "'wdth' 80"
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  none: "0px"
  sm: "6px"
  md: "10px"
  lg: "12px"
  full: "9999px"
spacing:
  row: "8px"
  gutter-mobile: "20px"
  gutter: "32px"
  column-gap: "48px"
  column-gap-wide: "56px"
  band: "80px"
  section: "96px"
  container-max: "84rem"
components:
  broadcast-bug:
    backgroundColor: "{colors.board}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.none}"
    padding: "8px 16px 8px 12px"
  score-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.navy}"
    typography: "{typography.score}"
    rounded: "{rounded.md}"
    width: "8rem"
  nameplate:
    backgroundColor: "{colors.board}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "6px 0"
    width: "8rem"
  result-board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.lg}"
    padding: "20px"
  lower-third-tabs:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.navy}"
    rounded: "{rounded.none}"
    padding: "6px"
  lower-third-tab-selected:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.gold}"
    typography: "{typography.label}"
    padding: "8px 12px"
  lower-third-tabs-on-gold:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.chalk}"
    padding: "6px"
  lower-third-tab-selected-on-gold:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.navy}"
    typography: "{typography.label}"
    padding: "8px 12px"
  lower-third-command:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.navy}"
    typography: "{typography.mono}"
    rounded: "{rounded.none}"
    padding: "8px 8px 8px 16px"
  button-copy:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
    width: "6.5rem"
  button-copy-hover:
    backgroundColor: "{colors.arena}"
    textColor: "{colors.chalk}"
  severity-toggle:
    textColor: "{colors.haze}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
  severity-toggle-checked:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.navy}"
  scoresheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.navy}"
    rounded: "{rounded.sm}"
    padding: "32px"
  chip-minor:
    textColor: "{colors.slate}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "2px 0"
    width: "4.75rem"
  chip-major:
    textColor: "{colors.red}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "2px 0"
    width: "4.75rem"
  chip-critical:
    backgroundColor: "{colors.red}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "2px 0"
    width: "4.75rem"
  running-order-row:
    backgroundColor: "{colors.arena}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.none}"
    padding: "24px 32px"
  running-order-numeral:
    backgroundColor: "{colors.board}"
    textColor: "{colors.haze}"
    typography: "{typography.led-row}"
    width: "6.5rem"
  running-order-numeral-landed:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.navy}"
    typography: "{typography.led-row}"
    width: "6.5rem"
  terminal:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.chalk}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "12px 16px"
  requirement-check:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    size: "20px"
---

# Design System: review-relay

## Overview

**Creative North Star: "The Judges' Panel"**

review-relay looks like a judging broadcast. A royal arena blue owns the ground. Judges hold up paper score cards from behind a desk, a gold telestrator ring circles the score that counts, and an LED result board lights with the verdict. The install command rides a lower-third band, the way a broadcast puts a caption across the bottom of the frame. Every visual device on the page comes from that one setting.

The voice is loud and sure. Headlines are condensed, extra-heavy Archivo set tight, numerals that are results glow in Doto's dot-matrix face, and commands sit in JetBrains Mono. Density is moderate: big type and big numerals up top, then plain, readable rows and tables below. The page is flat. Depth comes from tonal steps of blue and from cards physically rising out from behind the desk rail, never from shadows.

Paper is the second material. It appears as score cards, the scoresheet, the command bar, and the "Before the panel sits" section. Red ink lives only on paper. Gold marks what counts: the lowest score, the verdict sentence, the step where the comment lands, and the install.

**Key Characteristics:**
- Arena blue ground with tonal blue layers (deep, board) instead of shadows.
- Paper props (cards, sheet, command bar) carried on the blue.
- Gold as the counting mark and the action color; red only as ink on paper.
- One condensed broadcast voice for every heading; Doto LED only for result numerals.
- Square broadcast graphics, softly rounded physical props.
- One orchestrated motion moment on load; everything else is still.

## Colors

A saturated broadcast blue family carries the page, with paper and gold as the props placed on it and red reserved for ink.

### Primary
- **Arena Blue** (#1d2b8f): the page ground, the hero, the scoresheet section, and each running-order row. Also the Copy button's hover fill.
- **Arena Deep** (#131d6b): the running-order section ground and the desk front under the nameplates. One step darker than the arena.
- **Scoreboard Blue-Black** (#0a1040): the darkest blue. The result board, the broadcast bug, nameplates, running-order numeral cells, and the footer.
- **Desk Rail** (#3d4ca3): borders and dividers on blue, the desk rail the cards rise behind, the section top rule, and the scrollbar thumb.

### Secondary
- **Telestrator Gold** (#f2b705): the counting score's ring, the LED verdict, the second line of the hero headline, the landed step in the running order, the lower-third tab block, the closing band ground, focus rings and selection on blue.
- **Gold Ink** (#a87a00): the ring drawn on paper. Plain gold is too light to read on paper, so the scoresheet's ring uses this darker stroke.

### Tertiary
- **Pen Red** (#c42020): only on the scoresheet. Dimension scores of 3 or lower, capped merge-confidence scores and their "capped" note, and major and critical severity chips.

### Neutral
- **Chalk** (#ffffff): primary text on blue, and the checked segment of the severity control.
- **Haze** (#b8c2f2): secondary text on blue (ledes, captions, body copy in rows), the "/5" on the result board, and the logo's cue strokes.
- **Card Stock** (#f6f5f0): score cards, the scoresheet, the lower-third command bar, and the "Before the panel sits" section ground. A warm off-white, not pure white.
- **Sheet Rule** (#d9d8e6): table and list dividers on paper, and the card posts under each score card.
- **Ink Navy** (#0e1440): text on paper and gold, the Copy button, terminals, and the focus ring inside paper and gold regions.
- **Slate** (#4a5180): secondary text on paper (meta lines, column heads, the command prompt, minor chips).

### Named Rules
**The Arena Owns the Ground Rule.** Broadcast regions sit on arena blue or one of its darker steps. Paper and gold are props and bands placed on the blue, not a second theme.

**The Red Ink Rule.** Red appears only on paper, as the judge's pen marking a low or capped score or a serious finding. Red never touches the blue ground.

**The Gold Counts Rule.** Gold marks the score that counts, the verdict, the final event, and the install. Beyond those it appears only as interaction cues on blue (focus ring, selection, caret) and in the mark's check stroke. It never marks a value that does not count.

## Typography

**Display Font:** Archivo Variable (with ui-sans-serif, system-ui, sans-serif)
**Body Font:** Archivo Variable (same stack)
**Label/Mono Font:** Doto Variable for LED numerals (with ui-monospace); JetBrains Mono Variable for commands, paths, and repo meta (with ui-monospace)

**Character:** One family does the shouting and the talking. Archivo's width axis squeezed to 66% at weight 850 gives the broadcast headline voice, while the same family at normal width carries body copy. Doto's dot matrix reads as a scoreboard and is kept for numbers.

### Hierarchy
- **Display** (850, clamp(3.1rem, 6.4vw, 5.25rem), 0.92, width 66%): the hero headline only. The closing "Seat your panel." line uses a larger **display-close** size (clamp(3.25rem, 9vw, 6rem)).
- **Headline** (850, clamp(2.75rem, 5.5vw, 4.25rem), 0.92, width 66%): section titles.
- **Title** (850, 1.9rem, 0.92, width 66%): running-order step titles and the scoresheet's PR title.
- **Score** (850, clamp(4rem, 8.5vw, 6.75rem), tabular): the numeral on each score card. The scoresheet's merge-confidence row uses the same voice at 2.1rem to 2.4rem.
- **LED** (Doto 900, 5.5rem, 1, tabular): the result board verdict. The scoresheet's live headline score uses 4.5rem, running-order numerals 3rem on phones and 4rem from sm (**led-row**).
- **Body** (400, 1rem, 1.625): rows, requirements, and section ledes, held to about 62ch. The hero and closing ledes step up to 1.125rem (**body-lede**).
- **Label** (700, 0.8rem, 0.04em, width 80%, uppercase): nameplates, OS tabs, Copy, severity control, "Merge confidence", table column heads (0.7rem), and severity chips (0.68rem).
- **Mono** (JetBrains Mono 400, 0.8rem): the install command, terminals (0.84rem), file paths, commit and repo meta (0.75rem), and inline code at 0.86em of its parent.

### Named Rules
**The Broadcast Voice Rule.** Every heading on the page is Archivo at 66% width, weight 850, line-height 0.92, letter-spacing -0.01em. There is no second display face.

**The LED Is for Results Rule.** Doto is used only for numerals that are a result or a running-order position. Never for words, never for body numbers.

## Layout

A single centered container (max 84rem) with 20px side gutters on phones and 32px from sm (640px). Sections stack full-bleed with 96px vertical padding; the closing gold band uses 80px. Ground color changes mark the sections: arena, arena with a 2px rail on top, arena deep, paper, gold, then the board-colored footer.

The hero fills at least the small viewport height and centers its content. From lg (1024px) it is a two-column grid: a flexible left column and a 22rem right column, 48px apart. The headline spans the left, the lede sits bottom-aligned on the right, the judges' desk sits under the headline, the result board sits beside the desk, and the lower third spans both columns at the bottom. On phones the order is headline, lede, desk, lower third, then the result board, so the install comes before the board.

Content sections that pair a title with material use a fixed 19rem left column and a flexible right column, 56px apart. The running order is a stack of full-width rows 8px apart, each a fixed numeral cell (4.5rem on phones, 6.5rem from sm) plus a body that splits into a 20rem title column and a text column from lg. Judge seats share the desk width equally, with gaps of clamp(0.75rem, 3vw, 2.5rem) and cards capped at 8rem wide.

## Elevation & Depth

The system is flat. There are no box shadows anywhere. Depth comes from tonal steps of blue (board is darker than arena deep, which is darker than arena) and from one physical cue: score cards sit on posts and rise from behind a 12px desk rail, clipped by the desk so they appear to come up from below it. Paper reads as a separate layer only by its value contrast with the blue.

### Named Rules
**The Flat Broadcast Rule.** No shadows, glows, or blurs. Layering is done with darker blue steps and with objects that sit behind or in front of the desk rail.

## Shapes

Two shape families, split by what the thing is. Broadcast graphics are square: the broadcast bug, nameplates, the lower-third tabs, command bar and Copy button, running-order rows and numeral cells, the severity control, and severity chips all have 0px corners. Physical props have soft corners: score cards (10px), the result board (12px), and the scoresheet and terminals (6px). The requirement check mark sits in a full circle. Focus rings take a 4px radius.

The one free-drawn shape is the telestrator ring: an open, hand-drawn ellipse with round caps whose tail overshoots its start, drawn in gold around the counting score. On paper the same gesture is drawn in gold ink at a smaller size.

### Named Rules
**The Props Are Rounded Rule.** Things a person would hold or read on a desk (cards, board, sheet, terminal) get soft corners. Things that are on-screen broadcast graphics stay square.

## Components

### Buttons
Square, label-voiced, and solid.
- **Shape:** square corners (0px).
- **Copy:** Ink Navy fill, Chalk label text, 10px by 12px padding, fixed 6.5rem width so "Copy", "Copied", and "Selected" do not shift the bar. "Copied" adds a stroked check icon.
- **Hover / Focus:** hover fills with Arena Blue over a color transition. Focus shows a 2px Ink Navy ring offset 3px, since the button sits on paper.

### Lower Third (signature)
The install command as a broadcast caption band. A tab block on the left holds the OS tabs; a paper command bar fills the rest and ends in the Copy button. On phones the tab block stacks above the bar.
- **On blue:** the tab block is Telestrator Gold with Ink Navy labels; the selected tab inverts to Ink Navy with gold text.
- **On the gold band:** the tab block flips to Ink Navy with Chalk labels; the selected tab is gold with navy text.
- **Command:** mono text with a slate, non-selectable prompt ($ or >), scrolling horizontally rather than wrapping.
- **Tabs hover:** a 10% black wash. Windows visitors get the Windows tab preselected after hydration.

### Judges' Desk (signature)
Three paper score cards (4:5, 10px corners, navy score numerals) on Sheet Rule posts, rising from behind a Desk Rail strip. Below the rail, on Arena Deep, each judge has a square Scoreboard nameplate with a 1px rail-colored border and a Chalk uppercase label. The lowest card gets the gold telestrator ring. The whole desk is one labeled image for assistive tech.

### Result Board
A 12px-rounded Scoreboard panel with 20px padding. Repo and PR number in mono Haze, the PR title in semibold Chalk, a Desk Rail divider, then the verdict in gold LED numerals with a smaller Haze "/5", beside a "Merge confidence" label and a one-line explanation. A caption under the board marks the panel as an example.

### Scoresheet
A paper card (6px corners, 32px padding from sm, 20px on phones) with navy text. The PR title in the title voice above a 2px navy rule, a slate example note, then a table: dimensions in Archivo, scores in tabular mono, Sheet Rule row dividers, scores of 3 or less in bold Pen Red. The footer row repeats each judge's merge confidence in the broadcast voice, red when capped, and rings the counting one in Gold Ink. Findings follow as a list with severity chips and underlined mono file paths.

### Chips
- **Style:** square, 1px border, fixed 4.75rem width, uppercase label at 0.68rem.
- **Variants:** minor is a 50% Slate border with Slate text; major is a Pen Red border with red text; critical is a solid Pen Red fill with Card Stock text.

### Inputs / Fields
The only input is the severity control: a segmented radio group in a 1px Desk Rail frame with rail dividers between segments.
- **Style:** square, Haze uppercase labels, 10px by 12px padding.
- **Checked:** Chalk fill with Ink Navy text. Hover lifts the label to Chalk.
- **Focus:** a 2px gold outline offset 2px on the focused segment. The live LED score beside it updates and is announced.

### Running Order
Full-width square rows on Arena Blue, 8px apart, on the Arena Deep section. Each row starts with a Scoreboard numeral cell in Haze LED digits; the last row, where the comment lands, has a gold cell with navy digits. The row body holds a broadcast-voice title and Haze body copy.

### Navigation
There is no site navigation. The top-left broadcast bug (a square Scoreboard tab with the mark and an extrabold, 85%-width wordmark) links home, with the release version in a matching mono tab on the right when one exists. The footer, on Scoreboard, repeats the mark and lists download links in Haze with Desk Rail underlines that turn Haze and lift the text to Chalk on hover.

### Motion
One orchestrated moment plays once on load. The cards rise from below the desk (900ms, expo-out, staggered 140ms from 250ms), the ring draws itself around the lowest card (700ms, expo-out, 650ms after the last card), and the result board's numeral lights in three steps (600ms, 450ms after the ring). Everything else only transitions color on hover. With reduced motion, all animation and transitions are off and the final state shows at once.

**The One Moment Rule.** Only the judges' raise, the ring, and the board light animate. Nothing else on the page moves; hover only changes color.

## Do's and Don'ts

### Do:
- **Do** put broadcast regions on arena blue (#1d2b8f) or its darker steps, and carry paper and gold as props and bands on it.
- **Do** set every heading in the broadcast voice: Archivo at 66% width, weight 850, line-height 0.92.
- **Do** mark the score that counts with the hand-drawn telestrator ring: gold on blue, Gold Ink on paper.
- **Do** keep the install command in the lower-third band, one tap from Copy, with OS tabs and a non-selectable prompt.
- **Do** use Doto LED numerals for results and running-order positions only.
- **Do** switch focus rings to Ink Navy inside paper and gold regions; they are gold on blue.
- **Do** label every sample panel and scoresheet as an example on a fictional repo.

### Don't:
- **Don't** use red anywhere off the paper scoresheet.
- **Don't** add shadows, glows, or blurs; use a darker blue step instead.
- **Don't** round broadcast graphics (bands, tabs, nameplates, rows, chips); only physical props get corners.
- **Don't** put gold on a score, step, or value that does not count.
- **Don't** add a second display face or set Doto on words.
- **Don't** animate anything beyond the one load moment of raise, ring, and light.
