import type { Coder, Critic, Renderer } from './adapters.js';

const notImplemented = (kind: string) => () => {
  throw new Error(
    `Stub ${kind} adapter invoked. Replace it in gaido.config.ts with a real adapter implementation.`
  );
};

export function stubCoder(): Coder {
  return {
    kind: 'stub',
    run: notImplemented('coder'),
  };
}

export function stubCritic(): Critic {
  return {
    kind: 'stub',
    critique: notImplemented('critic'),
  };
}

export function stubRenderer(): Renderer {
  return {
    kind: 'stub',
    render: notImplemented('renderer'),
  };
}
