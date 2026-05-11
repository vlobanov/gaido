# Product

## Register

product

## Users

Gaido is open-source first. Two audiences carry equal weight in design.

**The generative coder.** Already fluent in Pixi, p5, canvas, shaders. Drawn
to graphs and exploration. Uses Gaido in long, flow-state sessions: type a
prompt, watch, fork, scan, fork. The tool succeeds when it disappears and the
work fills the screen.

**The artist running a production workflow.** Has a brief and a target
outcome. Reviews each run themselves (artist-in-the-loop critic) or hands the
review to an automated critic agent. The tool succeeds when the feedback loop
is legible and the favored variant is easy to ship.

Context across both audiences: solo at a wide screen, often headphones on,
time disappearing. Closer to a Figma + sketch pad combo than to a CI
dashboard. Sessions are long, branching, exploratory.

## Product Purpose

Gaido is a node-graph workspace for visual creative-agent workflows. A coder
agent writes visual code (Pixi/canvas/HTML), a renderer captures it as video,
and a critic (either an automated agent or the artist themselves) gives
feedback. The whole exploration is a forkable graph. Local-first,
single-user, file-system-backed, open source.

Success looks like: an artist sits down with a question, branches into thirty
variations across two hours, and the forking, watching, comparing all feel
like the natural shape of the work, not like operating software.

## Brand Personality

Scientific, generous, experimental. A lab notebook, not a dashboard.

- *Scientific*: every run has a timestamp, a parent, a diff, a critique. The
  work is honest about its own process. Failures and dead branches stay
  visible because they're part of the experiment.
- *Generous*: with whitespace, with reading time, with rendering time. The
  interface refuses to crowd the artist.
- *Experimental*: branching and variation are first-class. The graph itself
  is the celebration, not a "save this version" pattern.

Voice: confident and quiet. Plain English, never marketing language. Closer
to a researcher's notes than a product manager's copy. Restraint and
precision are tonal companions to the lab-notebook stance.

## Anti-references

- **Yet-another-zinc dashboard.** Linear/Vercel/Cursor zinc-dark + Inter +
  lucide icons. Reads as "AI tool" before anything else.
- **Corporate SaaS warmth.** Notion, Slack, Asana softness. Wrong tone for a
  creative tool.
- **Adobe / Autodesk pro-app density.** Ribbon panels, gray-on-gray, ten
  tools visible at once. Heavy and intimidating.
- **Game / playful / kid-coded.** Bright colors, mascots, big rounded
  buttons. Wrong seriousness.

Aesthetic lineage to draw from instead: generative-art tradition. Vera
Molnár, Casey Reas, Anni Albers, plotter art. Hairline rules, geometric
primitives, axis grids, monospace numerals, the texture of a workshop
sketchbook.

## Design Principles

1. **Lab notebook, not dashboard.** Show the work, the timestamps, the failed
   branches, the diffs. Don't hide process behind cleaned-up summaries.
2. **Generative-art lineage over SaaS conventions.** Visual language borrowed
   from plotter art and the creative-coding tradition. Axis grids and
   hairlines, not cards and pills. Numerals speak monospace.
3. **Generosity over density.** Whitespace and reading time are part of the
   flow. Bias toward removing.
4. **Honesty over polish.** Surface IDs, timestamps, commit shas, run
   numbers. The bones of the system are interesting; don't sand them into
   marketing-friendly euphemisms.
5. **The artist stays in the loop, not behind it.** Critic feedback (whether
   from an agent or the artist's own eye) is part of the canvas, not a
   deferred modal. Branching is the celebration; forks, retries, and dead
   ends are equal citizens.

## Accessibility & Inclusion

Personal-tool baseline. Keyboard navigation works, contrast doesn't fall
through the floor, no color-only signals on critical states. WCAG AAA is not
the design constraint. Revisit when external users become real.
