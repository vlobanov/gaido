import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const generate = customAlphabet(alphabet, 16);

export function newId(prefix: 'n' | 'r' | 'a' | 'e' | 'c'): string {
  return `${prefix}_${generate()}`;
}

export const nodeId = () => newId('n');
export const runId = () => newId('r');
export const artifactId = () => newId('a');
export const eventId = () => newId('e');
export const canvasId = () => newId('c');
