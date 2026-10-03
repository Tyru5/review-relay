---
name: review-relay
description: Your coding agents review every pull request, posted as one scored comment.
colors:
  night: "#0d0f1c"
  surface: "#14172b"
  raised: "#1b1f38"
  line: "#262b4a"
  ink: "#eceef8"
  muted: "#9398ba"
  relay: "#38d3f6"
  go: "#3deb8e"
  flag: "#b3a6f7"
typography:
  display:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.5rem (mobile) / 3.75rem (from 640px)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  lede:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.625
  small:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  caption:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.78rem to 0.84rem"
    fontWeight: 400
    lineHeight: 1.625
    fontFeature: "tnum"
rounded:
  chip: "4px"
  control: "6px"
  swatch: "8px"
  panel: "12px"
  dot: "9999px"
spacing:
  inline: "8px"
  group: "16px"
  block: "40px"
  hero-gap: "48px"
  ledger-gap: "64px"
  section: "80px"
components:
  button-copy:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    width: "5.25rem"
  button-copy-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  button-copy-copied:
    backgroundColor: "transparent"
    textColor: "{colors.go}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  tab-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  install-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  command-block:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  comment-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
  chip-finding:
    backgroundColor: "transparent"
    textColor: "{colors.flag}"
    typography: "{typography.caption}"
    rounded: "{rounded.chip}"
    padding: "0 6px"
  timeline-dot:
    backgroundColor: "{colors.relay}"
    rounded: "{rounded.dot}"
    size: "12px"
---

# Design System: review-relay

## Overview

**Creative North Star: "The Night Shift"**

review-relay does its work while the author is somewhere else: a review starts on GitHub, the agents they chose read the code, and a verdict appears on the pull request. The system is the calm, dark workspace that work happens in. Surfaces are quiet tonal layers of one deep blue-black, type is set plainly, and nothing glows at rest. Light is an event. A cyan signal means something is in flight; green means something landed; lavender means a finding wants attention. When a page uses color, a reader should be able to say what happened.

Density is moderate and left-aligned. Content reads like a ledger: a heading and one-line lede on the left, the substance on the right, separated from the next ledger by a single hairline. The signature is the timeline rail borrowed from a PR's own event history, a vertical line with dots, used for the sample review and for the steps of a review.

The page plays one moment on load: the review starts, the relay line draws, the scored comment lands. Everything else is still.

**Key Characteristics:**
- One dark ground with two tonal steps; depth by tone and hairline, never by shadow, blur, or glow.
- Three signal colors, each with one meaning; no decorative color anywhere.
- A single sans family at every level; monospace only for code, paths, versions, and numbers.
- The PR timeline rail as the recurring structural motif.
- One orchestrated load sequence; motion otherwise only answers a user's action.

## Colors

A blue-black workspace whose only color is information.

### Primary
- **Landing Green** (#3deb8e): the verdict and completed actions. The merge confidence score, its filled pips, the dot where a comment lands, the last step of a review, the Copy button after a successful copy. Never a hover color, never a bullet, never decoration.

### Secondary
- **Relay Cyan** (#38d3f6): something in flight. The review-started dot, the relay rail while a review runs, the steps before the verdict, keyboard focus rings, the text caret, and selection tint.

### Tertiary
- **Finding Lavender** (#b3a6f7): needs attention. Severity chips on findings and dimension scores of 3 or lower.

### Neutral
- **Night** (#0d0f1c): the page ground everywhere.
- **Surface** (#14172b): first tonal step. Comment card, install panel, command blocks.
- **Raised** (#1b1f38): second step. Selected tab, hovered controls.
- **Hairline** (#262b4a): borders, dividers, the quiet timeline rail, idle button outlines, scrollbar thumb.
- **Ink** (#eceef8): headlines, body emphasis, command text.
- **Muted Ink** (#9398ba): ledes, supporting copy, metadata, terminal prompts, captions. Holds about 6.5:1 on Night.

### Named Rules
**The Something-Landed Rule.** Green appears only where a verdict exists or an action completed. If nothing landed, nothing is green.

**The One Meaning Rule.** Each signal color has exactly one meaning across the product. A color used for decoration teaches the reader to ignore it.

## Typography

**Display Font:** Schibsted Grotesk Variable (with ui-sans-serif, system-ui)
**Body Font:** Schibsted Grotesk Variable
**Label/Mono Font:** JetBrains Mono Variable (with ui-monospace), for code only

**Character:** A sturdy newspaper grotesk that turns blunt and confident at 800 weight, paired with a clear coding mono that only shows up when the text is something you would type or read in a terminal. Both are self-hosted through Fontsource.

### Hierarchy
- **Display** (800, 2.5rem mobile / 3.75rem desktop, 1.05, -0.025em, balanced): the one hero headline.
- **Headline** (800, 1.875rem, 1.2, -0.025em): section titles in the ledger column.
- **Title** (600, 1rem, 1.5): step names, card labels, component headings.
- **Lede** (400, 1.125rem, 1.625, Muted Ink): the hero's supporting paragraph and section ledes; max 34rem.
- **Body** (400, 1rem, 1.625): step descriptions and prose; capped near 60ch.
- **Small / Caption** (400, 0.875rem / 0.75rem, Muted Ink): install note, table headers, the "Example review" caption. Sentence case, never tracked-out capitals.
- **Mono** (400, 0.78-0.84rem, tabular numbers): commands, file paths, repo identifiers, versions, scores in tables.

### Named Rules
**The Typed Text Rule.** Monospace marks text a person would type, copy, or read from a terminal. It is never a costume for looking technical.

## Layout

A centered container (max 72rem, 20px side padding, 32px from 640px). The hero is a two-column grid from 1024px: copy and install on the left, the sample review (27rem) on the right, 48px apart, vertically centered; below 1024px it stacks with the review after the install. Every following section is a ledger: an 18rem column for the headline and lede, a flexible column for content, 64px apart, stacking below 1024px. Sections are 80px tall in padding and separated by one hairline. Prose and lists cap near 60ch. Grid children set `min-width: 0` so long commands scroll inside their panel instead of widening the page.

### Named Rules
**The Ledger Rule.** Sections never center a headline over a grid of cards. Heading and lede on the left, content on the right.

## Elevation & Depth

Flat. Depth is a tonal step (Night to Surface to Raised) plus a 1px Hairline border. There are no shadows, no backdrop blur, and no glows. The only texture is the dot grid from the social preview, kept to the canvas behind the sample review and masked to fade at its edges.

### Named Rules
**The Lights-Off Rule.** At rest nothing casts light: no shadow, no blur, no glow. Declare elevation once, as tone plus hairline.

**The One Card Rule.** Cards never nest. A figure on the page is a canvas, not a card; only the comment inside it is a card.

## Shapes

Softly squared. Panels and cards use 12px corners, controls 6px, finding chips 4px, swatches 8px. Fully round shapes are reserved for signal dots and score pips. Borders are always 1px Hairline; a signal-tinted border appears only on a signal element (a finding chip, the Copied button).

## Components

### Buttons
- **Shape:** gently squared (6px), fixed width so the label can change without the layout moving.
- **Copy (default):** transparent with a Hairline outline and Ink text, 6px 12px padding.
- **Hover / Focus:** hover raises contrast only (Raised fill, Muted outline); focus shows the Relay Cyan ring at 3px offset.
- **Copied:** Landing Green text and a green-tinted outline for two seconds, announced through a polite live region. If clipboard access is blocked, the command is selected instead and the label reads "Selected".

### Tabs
- **Style:** text tabs inside the install panel's header strip; Muted Ink at rest, Ink on hover, Raised fill and Ink when selected. Uses `role="tablist"` with `aria-selected`. Windows is preselected after hydration on Windows browsers.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Surface on Night.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px Hairline; internal header separated by a Hairline rule.
- **Internal Padding:** 16px.

### Navigation
- **Style:** the header is the logo mark plus the lowercase wordmark at 800 weight, with the current version in Muted mono on the right once a release exists. Footer links are Muted Ink with a Hairline underline (4px offset) that brightens to Ink on hover.

### Timeline (signature)
A 2px vertical rail with 12px dots set 28px left of the content, borrowed from a pull request's event history. The rail is Hairline when idle and Relay Cyan while a review is in flight; dots take the signal of their event (cyan in flight, green landed, hollow Hairline not yet). In the hero it plays once: the started dot blinks twice, the rail draws downward, the comment rises in at 900ms with an expo ease-out, and the score pips fill. Reduced-motion users get the final state immediately.

### Install Panel
The page's primary action. A Surface panel with an OS tab strip and a single command row: Muted prompt, Ink command in mono that scrolls horizontally when it does not fit, and the Copy button.

## Do's and Don'ts

### Do:
- **Do** use Landing Green (#3deb8e) only for verdicts and completed actions.
- **Do** separate surfaces with a tonal step and a 1px Hairline (#262b4a).
- **Do** set code, paths, versions, and score numbers in JetBrains Mono with tabular numbers.
- **Do** label illustrative content as an example, as the sample review's caption does.
- **Do** keep the load sequence the only unprompted motion, and respect reduced motion.

### Don't:
- **Don't** add box shadows, backdrop blur, glows, or gradient text.
- **Don't** nest cards or turn sections into grids of same-size cards.
- **Don't** color hovers, bullets, or icons green or cyan for decoration.
- **Don't** put eyebrow labels or tracked capitals above headings.
- **Don't** tile the dot grid across the page; it belongs behind the sample review only.
