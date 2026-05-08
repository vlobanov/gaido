#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

register();

const here = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(here, '..', 'src', 'bin.ts')).href;

await import(entry);
