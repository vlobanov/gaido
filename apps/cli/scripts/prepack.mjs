// Assemble publish-only assets for the gaido package: the repo README and
// LICENSE (npm always includes these from the package root) and the bundled
// agent skill that `gaido init` offers to symlink into projects. Copies, not
// symlinks, so the tarball is self-contained; all destinations are gitignored.
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '..', '..');

cpSync(resolve(repoRoot, 'README.md'), resolve(pkgDir, 'README.md'));
cpSync(resolve(repoRoot, 'LICENSE'), resolve(pkgDir, 'LICENSE'));

const skillsDest = resolve(pkgDir, 'skills');
rmSync(skillsDest, { recursive: true, force: true });
cpSync(resolve(repoRoot, 'skills', 'gaido'), resolve(skillsDest, 'gaido'), {
  recursive: true,
});

console.log('[prepack] bundled README.md, LICENSE, skills/gaido');
