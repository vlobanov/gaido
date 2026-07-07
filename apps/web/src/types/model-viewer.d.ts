import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// Minimal JSX typing for the <model-viewer> custom element (from
// `@google/model-viewer`, registered via the side-effect import in Sidebar).
// Only the attributes the OutputPanel sets are declared; everything else falls
// through the base HTMLAttributes.
interface ModelViewerAttributes
  extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
  src?: string;
  poster?: string;
  alt?: string;
  'camera-controls'?: boolean;
  autoplay?: boolean;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerAttributes;
    }
  }
}
