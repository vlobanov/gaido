import { router } from '../trpc.js';
import { nodesRouter } from './nodes.js';
import { runsRouter } from './runs.js';
import { eventsRouter } from './events.js';
import { systemRouter } from './system.js';
import { lessonsRouter } from './lessons.js';
import { canvasesRouter } from './canvases.js';
import { skeletonsRouter } from './skeletons.js';
import { referencesRouter } from './references.js';

export const appRouter = router({
  nodes: nodesRouter,
  runs: runsRouter,
  events: eventsRouter,
  system: systemRouter,
  lessons: lessonsRouter,
  canvases: canvasesRouter,
  skeletons: skeletonsRouter,
  references: referencesRouter,
});

export type AppRouter = typeof appRouter;
