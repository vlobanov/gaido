import { router } from '../trpc.js';
import { nodesRouter } from './nodes.js';
import { runsRouter } from './runs.js';
import { eventsRouter } from './events.js';

export const appRouter = router({
  nodes: nodesRouter,
  runs: runsRouter,
  events: eventsRouter,
});

export type AppRouter = typeof appRouter;
