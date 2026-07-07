import { defineSkeleton, blenderRenderer } from 'gaido';

/**
 * Blender preset overlay: routes nodes using this skeleton to the headless
 * Blender renderer (Eevee → mp4, plus a GLB export) instead of the default
 * browser renderer. Layers over gaido.config.ts for every node using this
 * skeleton — see the default skeleton's gaido.skeleton.ts for merge rules.
 */
export default defineSkeleton({
  renderer: blenderRenderer(),
});
