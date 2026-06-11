// Build the web UI and vendor it into web-dist/ so the published package
// serves the bundled interface (server.ts looks there first, then at the
// monorepo sibling apps/web/dist). Also copies the repo LICENSE. Both
// destinations are gitignored.
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');

execSync('pnpm --filter @gaido/web build', { cwd: repoRoot, stdio: 'inherit' });

const webDist = resolve(pkgDir, 'web-dist');
rmSync(webDist, { recursive: true, force: true });
cpSync(resolve(repoRoot, 'apps', 'web', 'dist'), webDist, { recursive: true });

cpSync(resolve(repoRoot, 'LICENSE'), resolve(pkgDir, 'LICENSE'));

console.log('[prepack] built web UI into web-dist/, copied LICENSE');
