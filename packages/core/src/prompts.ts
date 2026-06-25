import type { Critique } from './types.js';

/**
 * Filename the coder writes at the worktree root to talk back to the artist.
 * Picked up by the orchestrator after the coder phase commits.
 */
export const MESSAGE_FILENAME = 'MESSAGE.md';

/**
 * Render a critique into the feedback text handed to the next coder when the
 * artist continues from it — and the default text shown in the Edit-critique
 * dialog. The coder resumes the prior session but never saw the critique (the
 * critic is a separate agent), so this string is the only channel for the
 * critique to reach the next attempt: the `overall` assessment first, then any
 * `suggestions` as a bulleted list. Editing a critique folds everything into
 * `overall` and clears `suggestions`, so re-rendering an edited critique
 * yields just the artist's prose with no duplication.
 */
export function critiqueFeedback(
  critique: Pick<Critique, 'overall' | 'suggestions'>
): string {
  const parts: string[] = [];
  const overall = critique.overall?.trim();
  if (overall) parts.push(overall);
  const suggestions = (critique.suggestions ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (suggestions.length) {
    parts.push(
      ['Suggestions to address:', ...suggestions.map((s) => `- ${s}`)].join('\n')
    );
  }
  return parts.join('\n\n');
}

export type CoderMessageKind = 'question' | 'limitation' | 'note';

/**
 * Structured form of MESSAGE.md after parsing. Frontmatter fields are the
 * coder's contract; `body` is the prose message shown to the artist.
 */
export interface CoderMessage {
  /**
   * False → orchestrator skips render and critic auto-spawn; the message is
   * the run's terminal output. True → render normally and surface the
   * message alongside the video as a note.
   */
  producedArtifact: boolean;
  kind: CoderMessageKind;
  body: string;
}

/**
 * Framework-level preamble prepended to the artist's instruction on every
 * fresh coder session. Sibling to LESSONS.md injection — sits above it in
 * the assembled instruction so framework rules read first, then project
 * rules, then the artist's ask. Resumed sessions already saw this at turn 1
 * and don't get it again.
 */
export const GAIDO_PROTOCOL_PREAMBLE = `GAIDO PROTOCOL:

You are running inside the gaido framework. By default the artist sees your work as a rendered video produced from the code in this worktree. Your normal output is code; rendering happens automatically afterwards.

There is a SEPARATE communication channel for talking to the artist in plain prose when code isn't the right answer. To use it, write a file named ${MESSAGE_FILENAME} at the worktree root in EXACTLY this format:

---
producedArtifact: false
kind: question
---

<your message to the artist, in plain prose. Markdown is fine.>

Frontmatter fields:
- producedArtifact: false  → no render this turn; the message IS the run's output. gaido will skip rendering entirely and show your message in the conversation panel.
                  true    → render the code normally AND attach the message as a note alongside the video.
- kind: question | limitation | note  (pick the one that fits)

Use this channel when ANY of the following apply:
- The artist asked you a QUESTION that needs a prose answer, not code (e.g., "why did you do X?", "what would happen if Y?", "is Z possible?"). Answer in ${MESSAGE_FILENAME} with producedArtifact:false — do NOT edit code just to "answer" a question.
- The request is technically or physically impossible — say so instead of producing a degraded render.
- The request is ambiguous and guessing would waste a render — ask for the missing piece.
- You made a non-obvious interpretation worth flagging — surface it as a note (use producedArtifact:true if you also changed code).

Do not use this channel as an excuse to skip real work. If the artist asked for an animation, build the animation. The channel is for cases where prose is genuinely what's needed.

The artist sees your message in a conversation thread and can reply; their reply arrives as the next turn in your resumed session so the back-and-forth continues naturally.`;
