import fs from 'node:fs';
import path from 'node:path';
import type { Coder, Critic, Renderer } from './adapters.js';

const notImplemented = (kind: string) => () => {
  throw new Error(
    `Stub ${kind} adapter invoked. Replace it in gaido.config.ts with a real adapter implementation.`
  );
};

/**
 * Stub coder for fresh projects. Does not call any LLM. Writes a small
 * `STUB.md` into the workdir noting the instruction so the orchestrator
 * has a non-empty diff to commit each run, and emits a few fake tokens so
 * the UI animates.
 */
export function stubCoder(): Coder {
  return {
    kind: 'stub',
    async run(input, ctx) {
      const tokens = ['Stub coder ', 'pretending ', 'to ', 'think...'];
      for (const text of tokens) {
        if (ctx.abortSignal.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        ctx.emit({ kind: 'agent_token', phase: 'coding', text });
        await sleep(150, ctx.abortSignal);
      }

      const stubPath = path.join(ctx.workdir, 'STUB.md');
      const prior = fs.existsSync(stubPath) ? fs.readFileSync(stubPath, 'utf8') : '';
      const next =
        prior +
        `\n## run ${ctx.runId}\n` +
        `at: ${new Date().toISOString()}\n` +
        `instruction: ${input.instruction}\n` +
        (input.followUp ? `follow-up: ${input.followUp}\n` : '');
      fs.writeFileSync(stubPath, next.trimStart() + '\n');

      return { sessionId: null };
    },
  };
}

/**
 * Stub critic. Returns canned Critique data referencing the prompt so the
 * UI end-to-end flow works on `gaido init` without a real critic adapter.
 */
export function stubCritic(): Critic {
  return {
    kind: 'stub',
    async critique(input, ctx) {
      const tokens = ['Stub critic ', 'evaluating ', 'output...'];
      for (const text of tokens) {
        if (ctx.abortSignal.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        ctx.emit({ kind: 'agent_token', phase: 'critiquing', text });
        await sleep(150, ctx.abortSignal);
      }

      const prompt = input.prompt.trim() || '(no prompt)';
      return {
        critique: {
          overall: `Stub critique of: "${prompt}". Replace stubCritic in gaido.config.ts with a real adapter to evaluate renders.`,
          rating: 3,
          strengths: ['Renders without errors', 'Honors the prompt shape'],
          weaknesses: ['No real evaluation happened — this is canned output'],
          suggestions: [
            'Wire up @gaido/adapter-claude-code or another Critic implementation',
            'Iterate on the skeleton/CLAUDE.md to guide the coder',
          ],
        },
      };
    },
  };
}

export function stubRenderer(): Renderer {
  return {
    kind: 'stub',
    render: notImplemented('renderer'),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
