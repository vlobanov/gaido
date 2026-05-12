import fs from 'node:fs';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';

const HEADER = [
  '# Project rules',
  '',
  'Promoted from critiques (and added manually). The coder reads this file before every fresh run; resumed sessions keep the rules they saw at turn 1.',
  '',
  '',
].join('\n');

export const lessonsRouter = router({
  get: publicProcedure.query(({ ctx }) => {
    const path = ctx.paths.lessonsFile;
    if (!fs.existsSync(path)) return { contents: null as string | null };
    const contents = fs.readFileSync(path, 'utf8');
    return { contents };
  }),

  promote: publicProcedure
    .input(z.object({ rule: z.string().min(1).max(500) }))
    .mutation(({ ctx, input }) => {
      const path = ctx.paths.lessonsFile;
      const rule = stripBullet(input.rule);
      if (!rule) return { contents: null as string | null, added: false as const };
      const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
      const body = existing || HEADER;
      const target = normalize(rule);
      const already = body
        .split('\n')
        .some((line) => normalize(stripBullet(line)) === target);
      if (already) return { contents: body, added: false as const };
      const needsNl = body.endsWith('\n') ? '' : '\n';
      const next = `${body}${needsNl}- ${rule}\n`;
      fs.writeFileSync(path, next);
      return { contents: next, added: true as const };
    }),
});

function stripBullet(line: string): string {
  return line.replace(/^\s*[-•*]\s*/, '').trim();
}

function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/, '')
    .trim();
}
