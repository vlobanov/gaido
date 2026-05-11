---
name: Gaido
description: A working lab notebook for visual creative-agent workflows on a node graph.
---

<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: Gaido

## 1. Overview

**Creative North Star: "The working notebook of a generative-coding studio."**

Gaido is the digital equivalent of a researcher's grid-ruled notebook left
open on a workbench: warm cream paper, deep ink for the body of the work,
hairline rules to keep things in register, and a single saturated spot color
used like red pencil in a margin. Nothing decorative. Numerals speak
monospace because runs, timestamps, and commit shas need to be legible as
data, not styled as copy. Prose carries weight in a real workhorse serif,
the way a working scientist or a working writer reads.

The system is approachable and function-forward. The lineage is canvas tools
that welcome their users (tldraw, Excalidraw, Quill.io), not gallery-precious
editorial sites. The graph itself is the artifact, so the chrome around it
has to step back. Calm, generous, present, never theatrical.

It is explicitly NOT a zinc-on-zinc AI-tool dashboard (Cursor / Linear /
Vercel); not Notion / Slack corporate-SaaS warmth; not Adobe / Autodesk
pro-app density; not game UI. The strategic anti-references in PRODUCT.md
carry through here at the visual level.

**Key Characteristics:**

- Cream-paper canvas, deep-ink type, one disciplined accent.
- Serif display + monospace body; mono carries labels and numerals.
- Hairline rules and axis grids over filled cards and pills.
- Honest surfacing of IDs, timestamps, run numbers, commit shas.
- Considered transitions, no entrance choreography, no motion theater.

## 2. Colors

A restrained palette: warm-cream surface and deep-ink type doing nearly all
the work, with a single saturated accent used like red pencil in the margin.

**Strategy: Restrained.** Tinted neutrals plus one disciplined accent used
on no more than ~10% of any given screen.

### Primary (accent)

- **Margin Pencil** (single saturated hue, *[to be resolved during
  implementation]*): one hue, one job. Used on truly active selection, the
  favorited marker, the ship affordance. Candidates worth probing:
  cinnabar / sanguine red, prussian / cobalt blue, oxide ochre, plotter
  carmine. Pick one and commit; do not introduce a second accent role.

### Neutral

- **Paper Cream** (*[to be resolved]*): canvas surface. Warm off-white
  tinted toward the accent hue (chroma ≤0.01 in OKLCH). Not screen white.
  Reads as rag paper.
- **Deep Ink** (*[to be resolved]*): body type. Near-black, tinted warm to
  belong with the paper. Reads as ink, not pixels.
- **Hairline Grey** (*[to be resolved]*): rules, dividers, axis lines, node
  outlines. Low-contrast on cream, visible but quiet.
- **Margin Note** (*[to be resolved]*): mid-grey for timestamps, secondary
  metadata, less-active text. Sits between hairline and ink.

### Named Rules

**The Margin-Pencil Rule.** The accent is used like a red pencil in a
margin: sparingly, deliberately, never as decoration. If it's everywhere,
it's nowhere. ~10% maximum on any screen.

**The Warm-Tint Rule.** Every neutral carries a small warm tint toward the
accent's hue (chroma 0.005–0.01 in OKLCH). No `#000`, no `#fff`, no
cool-blue greys. The cream and ink have to look like they belong on the
same page.

## 3. Typography

**Display Font:** workhorse serif (*[Lyon, Spectral, EB Garamond, Source
Serif, GT Sectra, or similar; to be resolved during implementation]*). Quiet,
readable, scientific. Not editorial-precious.

**Body Font:** monospace (*[Berkeley Mono, JetBrains Mono, IBM Plex Mono, or
similar]*). Carries labels, numerals, instructions, run metadata, IDs.

**Character:** a working scientist's pairing, not a magazine pairing. The
serif reads as prose; the mono reads as data. Sitting near each other should
look like a research note next to a code snippet, not like a designer's
typography demo.

### Hierarchy

- **Display** (serif, large, normal weight): section anchors, rare moments.
  Used sparingly, never on every screen.
- **Headline** (serif, medium, normal weight): node titles, sidebar
  headings, primary instruction prose.
- **Title** (mono, small-medium, medium weight): run labels, status labels,
  section titles inside the sidebar.
- **Body** (mono, regular weight, ~14px target): default text. Instructions,
  event rows, run metadata. Line length capped at 65–75ch.
- **Label** (mono, ~10–11px, medium weight, uppercase, generous tracking):
  small category labels (NODE, OUTPUT, CURRENT RUN). The voice of a card
  catalog.

### Named Rules

**The Numerals-Speak-Mono Rule.** Every numeral is monospaced and tabular:
timestamps, durations, run indices, commit shas, node IDs. Numerals are
data, not copy. They line up vertically.

**The No-Inter Rule.** Inter and the default system sans stack are the
explicit anti-typeface for Gaido. They are the typographic signature of the
"yet-another-zinc dashboard" lane PRODUCT.md rejects. The mono body is the
voice; the serif is the second voice. Inter has no place.

## 4. Elevation

Flat by default. Depth lives in tonal layering and hairlines, not in
shadows. A workshop notebook has rules and registration marks, not drop
shadows.

State (hover, focus, active selection) is conveyed by **a hairline edge or
a half-percent tint shift**, not by lift. The accent is the loudest depth
signal the system uses, and only on truly active selection or favorited
paths.

### Named Rules

**The No-Lift Rule.** No `box-shadow`. Ever. Where another system would
lift a card on hover, Gaido shifts the surface tint a half-percent or shows
a hairline border. The page stays flat the way a real notebook page stays
flat.

## 6. Do's and Don'ts

### Do:

- **Do** use a warm cream surface tinted toward the accent's hue. Surface
  feels like rag paper, not screen white.
- **Do** monospace every numeral: timestamps, durations, run indices, IDs,
  commit shas. They line up vertically.
- **Do** use hairline rules, axis grids, and tonal layering in place of
  filled cards and drop shadows.
- **Do** keep the accent rare. Margin-pencil discipline: ~10% maximum on
  any given screen.
- **Do** treat transitions as feedback: state changes, content-arrival
  eases. Exponential ease-out curves, short durations.

### Don't:

- **Don't** ship zinc-on-zinc dark mode + Inter + lucide icons. That is the
  Cursor / Linear / Vercel lane PRODUCT.md rejects by name. The current
  scaffolding in `apps/web` is the wrong lane; it gets replaced.
- **Don't** use Inter or the default system sans stack. See The No-Inter
  Rule.
- **Don't** add `box-shadow` for elevation. Tonal layering and hairlines
  only. See The No-Lift Rule.
- **Don't** introduce `border-left` greater than 1px as a colored accent
  stripe on cards, alerts, or rows. The general absolute ban applies.
- **Don't** drift into Notion / Craft / Obsidian visual territory: rounded
  card grids, beige-on-beige surfaces, gentle gray dividers. Lab notebook,
  not docs app.
- **Don't** use gradient text or glassmorphism. Both are decorative
  AI-slop signals.
- **Don't** add bounce or elastic motion easings. Considered exponential
  ease-outs only.
