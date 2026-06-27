import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { AwsClient } from 'aws4fetch';
import { schema } from '@vadimlobanov/gaido-core';
import type { PublishConfig } from '@vadimlobanov/gaido-core';
import { resolvePaths, type Paths } from './paths.js';
import { loadEnv } from './env-loader.js';
import { loadConfig, type ResolvedConfig } from './config-loader.js';
import { openDb, type Db } from './db.js';
import { createWorkspaceManager } from './workspace.js';
import { createPreviewArchiver } from './previews.js';
import { resolveSkeleton } from './skeletons.js';
import { buildCanvasSnapshot } from './snapshot.js';

/**
 * `gaido publish` — bake a canvas into a static, read-only bundle and push it
 * to Cloudflare R2 (or write it to a local dir). Fully single-origin: pages,
 * the viewer bundle, media, and live previews all sit under one `siteUrl`, with
 * R2 object keys mirroring the URL paths so the Worker is a pure passthrough.
 * See `docs/publishing.md`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PAGE_CACHE = 'public, max-age=60, must-revalidate';

export interface PublishOptions {
  cwd?: string;
  /** Canvas slug or id. Omitted → the sole canvas, or error if several (use `all`). */
  canvas?: string;
  /** Publish every canvas. */
  all?: boolean;
  /** Also write the bundle to this local directory (for inspection / local preview). */
  outDir?: string | null;
  /** Push to R2. Default true. */
  upload?: boolean;
  /** Override `publish.siteUrl` — e.g. a localhost origin to preview a publish locally. */
  siteUrlOverride?: string | null;
  /** Override viewer-bundle location (a static `vite build`). Auto-detected otherwise. */
  viewerDist?: string;
  frameworkAlias?: Record<string, string>;
  /**
   * Gate before uploading. Returns false to abort. The CLI wires this to an
   * interactive y/N (skipped with `--yes`); it's where the source-publish
   * warning lives.
   */
  confirm?: (info: { willPublishSource: boolean; canvases: string[] }) => Promise<boolean>;
  log?: (msg: string) => void;
  /** Epoch ms stamp. Defaults to `Date.now()`. */
  publishedAt?: number;
}

export interface PublishedCanvas {
  slug: string;
  publishSlug: string;
  url: string;
  entries: number;
  bytes: number;
  uploaded: boolean;
}

export interface PublishResult {
  canvases: PublishedCanvas[];
  aborted: boolean;
}

interface BundleEntry {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

interface Bundle {
  publishSlug: string;
  entries: BundleEntry[];
  totalBytes: number;
}

export async function publishCanvas(opts: PublishOptions): Promise<PublishResult> {
  const paths = resolvePaths(opts.cwd);
  loadEnv(paths.projectDir);
  const { config } = await loadConfig(
    paths.configFile,
    opts.frameworkAlias ? { frameworkAlias: opts.frameworkAlias } : {}
  );

  const publish = config.publish;
  if (!publish) {
    throw new Error(
      'No `publish` config in gaido.config.ts. Add a `publish: { siteUrl, r2 }` ' +
        'block — see docs/publishing.md.'
    );
  }
  const siteUrl = (opts.siteUrlOverride ?? publish.siteUrl ?? '').replace(/\/+$/, '');
  if (!siteUrl) throw new Error('publish.siteUrl is empty.');

  const upload = opts.upload ?? true;
  const publishedAt = opts.publishedAt ?? Date.now();
  const viewerDist = resolveViewerDist(opts.viewerDist);
  const log = opts.log ?? (() => {});

  const { db, sqlite } = openDb(paths.dbFile, paths.migrationsDir);
  try {
    const targets = resolveTargets(db, opts);
    const willPublishSource = !!publish.include?.livePreviews;

    if (opts.confirm) {
      const ok = await opts.confirm({
        willPublishSource,
        canvases: targets.map((c) => c.slug),
      });
      if (!ok) return { canvases: [], aborted: true };
    }

    const r2 = upload ? makeR2(publish) : null;
    const viewerBuild = viewerBuildId(viewerDist);
    const published: PublishedCanvas[] = [];

    for (const canvas of targets) {
      const workspace = createWorkspaceManager({
        runsDir: paths.runsDir,
        resolveSkeleton: (n) => resolveSkeleton(n, { projectDir: paths.projectDir }),
      });
      const archiver = createPreviewArchiver({ workspace, paths });

      const bundle = await buildBundle({
        db,
        config,
        publish,
        canvas,
        siteUrl,
        viewerDist,
        viewerBuild,
        publishedAt,
        archiver,
        lessonsFile: paths.lessonsFile,
      });

      if (opts.outDir) writeBundleLocal(bundle, opts.outDir);
      if (r2) {
        log(`uploading ${bundle.entries.length} objects to r2://${publish.r2.bucket}…`);
        await uploadBundle(bundle, r2, publish.r2.bucket, log);
      }
      writeManifest(paths, canvas, bundle.publishSlug, siteUrl, publishedAt);

      published.push({
        slug: canvas.slug,
        publishSlug: bundle.publishSlug,
        url: `${siteUrl}/${bundle.publishSlug}`,
        entries: bundle.entries.length,
        bytes: bundle.totalBytes,
        uploaded: !!r2,
      });
    }
    return { canvases: published, aborted: false };
  } finally {
    sqlite.close();
  }
}

interface CanvasTarget {
  id: string;
  slug: string;
  name: string | null;
}

function resolveTargets(db: Db, opts: PublishOptions): CanvasTarget[] {
  const all = db.select().from(schema.canvases).all();
  const pick = (c: (typeof all)[number]): CanvasTarget => ({ id: c.id, slug: c.slug, name: c.name });
  if (opts.all) return all.map(pick);
  if (opts.canvas) {
    const c = all.find((x) => x.slug === opts.canvas || x.id === opts.canvas);
    if (!c) {
      throw new Error(
        `canvas "${opts.canvas}" not found. Have: ${all.map((x) => x.slug).join(', ') || '(none)'}.`
      );
    }
    return [pick(c)];
  }
  const [only] = all;
  if (only && all.length === 1) return [pick(only)];
  throw new Error(
    all.length === 0
      ? 'No canvases to publish.'
      : `Multiple canvases — name one (${all.map((x) => x.slug).join(', ')}) or pass --all.`
  );
}

async function buildBundle(args: {
  db: Db;
  config: ResolvedConfig;
  publish: PublishConfig;
  canvas: CanvasTarget;
  siteUrl: string;
  viewerDist: string;
  viewerBuild: string | undefined;
  publishedAt: number;
  archiver: { ensureArchive: (sha: string) => Promise<string> };
  lessonsFile: string;
}): Promise<Bundle> {
  const { db, config, publish, canvas, siteUrl, viewerDist } = args;

  const publishSlug = publish.slug ? publish.slug(canvas) : canvas.slug;
  if (publishSlug === 'assets' || publishSlug === 'p') {
    throw new Error(
      `publishSlug "${publishSlug}" is reserved (pages live at /<slug>; "assets" and "p" are taken).`
    );
  }

  const include = publish.include ?? {};
  const livePreviews = include.livePreviews ?? false;

  // Rows we need by-id (the snapshot strips disk paths, so query them here).
  const nodeIds = db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(eq(schema.nodes.canvasId, canvas.id))
    .all()
    .map((r) => r.id);
  const runs = nodeIds.length
    ? db
        .select({ id: schema.runs.id, commitSha: schema.runs.commitSha })
        .from(schema.runs)
        .where(inArray(schema.runs.nodeId, nodeIds))
        .all()
    : [];
  const runIds = runs.map((r) => r.id);
  const artifactRows = runIds.length
    ? db
        .select()
        .from(schema.artifacts)
        .where(inArray(schema.artifacts.runId, runIds))
        .all()
        .filter((a) => a.kind === 'video' || a.kind === 'thumbnail')
    : [];
  const imageRefRows = nodeIds.length
    ? db
        .select()
        .from(schema.nodeReferences)
        .where(inArray(schema.nodeReferences.nodeId, nodeIds))
        .all()
        .filter((r) => r.kind === 'image' && r.filePath)
    : [];
  const imageRefIds = new Set(imageRefRows.map((r) => r.id));

  const rules =
    (include.rules ?? true) && fs.existsSync(args.lessonsFile)
      ? fs.readFileSync(args.lessonsFile, 'utf8')
      : null;

  const previewKey = (sha: string) => sha.slice(0, 12);

  const snapshot = buildCanvasSnapshot(db, config, canvas.id, {
    publishedAt: args.publishedAt,
    publishSlug,
    include: {
      ...(include.instructions !== undefined ? { instructions: include.instructions } : {}),
      ...(include.events !== undefined ? { events: include.events } : {}),
      ...(include.rules !== undefined ? { rules: include.rules } : {}),
    },
    redact: {
      ...(publish.redact?.artistFollowUp !== undefined
        ? { artistFollowUp: publish.redact.artistFollowUp }
        : {}),
    },
    rules,
    siteUrl,
    ...(args.viewerBuild ? { viewerBuild: args.viewerBuild } : {}),
    urls: {
      artifact: ({ id, ext }) => `${siteUrl}/${publishSlug}/artifacts/${id}${ext}`,
      preview: ({ commitSha }) =>
        livePreviews && commitSha ? `${siteUrl}/p/${previewKey(commitSha)}/` : null,
      imageRef: ({ id, ext }) =>
        imageRefIds.has(id) ? `${siteUrl}/${publishSlug}/refs/${id}${ext}` : null,
    },
  });

  const entries: BundleEntry[] = [];

  // The page: viewer shell + inlined snapshot. Root-absolute /assets/* refs in
  // the shell resolve against siteUrl, so no rewriting. Pushed LAST (below) so
  // an upload only goes live once its assets/media already exist.
  const pageEntry: BundleEntry = {
    key: `${publishSlug}/index.html`,
    body: Buffer.from(renderPageHtml(viewerDist, snapshot), 'utf8'),
    contentType: 'text/html; charset=utf-8',
    cacheControl: PAGE_CACHE,
  };

  // Shared viewer bundle (content-hashed → immutable, idempotent re-upload).
  for (const file of walk(path.join(viewerDist, 'assets'))) {
    entries.push({
      key: path.relative(viewerDist, file).split(path.sep).join('/'),
      body: fs.readFileSync(file),
      contentType: mimeOf(file),
      cacheControl: IMMUTABLE,
    });
  }

  // 3. Media (video + thumbnail), keyed by artifact id.
  for (const a of artifactRows) {
    if (!fs.existsSync(a.path)) continue;
    const ext = path.extname(a.path);
    entries.push({
      key: `${publishSlug}/artifacts/${a.id}${ext}`,
      body: fs.readFileSync(a.path),
      contentType: a.mime,
      cacheControl: IMMUTABLE,
    });
  }

  // 4. Reference images.
  for (const r of imageRefRows) {
    if (!r.filePath || !fs.existsSync(r.filePath)) continue;
    const ext = path.extname(r.filePath);
    entries.push({
      key: `${publishSlug}/refs/${r.id}${ext}`,
      body: fs.readFileSync(r.filePath),
      contentType: r.mime ?? mimeOf(r.filePath),
      cacheControl: IMMUTABLE,
    });
  }

  // 5. Live previews — each run's committed source, deduped by commit.
  if (livePreviews) {
    const seen = new Set<string>();
    for (const r of runs) {
      if (!r.commitSha) continue;
      const k = previewKey(r.commitSha);
      if (seen.has(k)) continue;
      seen.add(k);
      const dir = await args.archiver.ensureArchive(r.commitSha);
      for (const file of walk(dir)) {
        const rel = path.relative(dir, file).split(path.sep).join('/');
        // Don't publish agent instructions / overlay control files.
        if (rel === 'CLAUDE.md' || rel.endsWith('/CLAUDE.md')) continue;
        entries.push({
          key: `p/${k}/${rel}`,
          body: fs.readFileSync(file),
          contentType: mimeOf(file),
          cacheControl: IMMUTABLE,
        });
      }
    }
  }

  // Page last — the atomic-ish "commit" of a publish.
  entries.push(pageEntry);

  const totalBytes = entries.reduce((n, e) => n + e.body.length, 0);
  return { publishSlug, entries, totalBytes };
}

function renderPageHtml(viewerDist: string, snapshot: unknown): string {
  const tplPath = path.join(viewerDist, 'index.html');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  if (tpl.includes('__GAIDO_SNAPSHOT__')) {
    throw new Error(`${tplPath} already contains a snapshot — use a clean static build.`);
  }
  // Escape `<` so a `</script>` inside the data can't break out of the tag.
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const tag = `<script>window.__GAIDO_SNAPSHOT__=${json};</script>`;
  if (!/<script type="module"/.test(tpl)) {
    throw new Error(`${tplPath} has no <script type="module"> to inject before.`);
  }
  return tpl.replace(/<script type="module"/, `${tag}\n  <script type="module"`);
}

function makeR2(publish: PublishConfig): { client: AwsClient; base: string } {
  const { accountId, accessKeyId, secretAccessKey, endpoint, region } = publish.r2;
  const missing = [
    !endpoint && !accountId && 'accountId (or endpoint)',
    !accessKeyId && 'accessKeyId',
    !secretAccessKey && 'secretAccessKey',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `publish.r2 missing ${missing.join(', ')} — set the R2 credentials in your ` +
        `.env (GAIDO_R2_*). Or pass --no-upload to build the bundle without pushing.`
    );
  }
  const base = (endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: region ?? 'auto',
    service: 's3',
  });
  return { client, base };
}

async function uploadBundle(
  bundle: Bundle,
  r2: { client: AwsClient; base: string },
  bucket: string,
  log: (msg: string) => void
): Promise<void> {
  for (const e of bundle.entries) {
    const url = `${r2.base}/${bucket}/${e.key}`;
    const res = await r2.client.fetch(url, {
      method: 'PUT',
      body: e.body,
      headers: { 'content-type': e.contentType, 'cache-control': e.cacheControl },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`R2 PUT ${e.key} → ${res.status} ${res.statusText} ${detail}`.trim());
    }
    log(`  ↑ ${e.key} (${e.body.length}b)`);
  }
}

function writeBundleLocal(bundle: Bundle, outDir: string): void {
  for (const e of bundle.entries) {
    const dest = path.join(outDir, e.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.body);
  }
}

interface ManifestEntry {
  slug: string;
  publishSlug: string;
  siteUrl: string;
  publishedAt: number;
}
type Manifest = Record<string, ManifestEntry>;

function manifestPath(paths: Paths): string {
  return path.join(paths.runsDir, '.publish', 'manifest.json');
}

function readManifest(paths: Paths): Manifest {
  const file = manifestPath(paths);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest) : {};
}

function writeManifest(
  paths: Paths,
  canvas: CanvasTarget,
  publishSlug: string,
  siteUrl: string,
  publishedAt: number
): void {
  const file = manifestPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = readManifest(paths);
  data[canvas.id] = { slug: canvas.slug, publishSlug, siteUrl, publishedAt };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function dropManifestByPublishSlug(paths: Paths, publishSlug: string): void {
  const file = manifestPath(paths);
  if (!fs.existsSync(file)) return;
  const data = readManifest(paths);
  for (const [id, entry] of Object.entries(data)) {
    if (entry.publishSlug === publishSlug) delete data[id];
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export interface UnpublishOptions {
  cwd?: string;
  /** Canvas slug / id / publishSlug. */
  canvas?: string;
  /** Unpublish every canvas in the local manifest. */
  all?: boolean;
  frameworkAlias?: Record<string, string>;
  log?: (msg: string) => void;
}

export interface UnpublishResult {
  removed: { publishSlug: string; objects: number }[];
}

/**
 * Remove a published canvas's page + media from R2 (the `<publishSlug>/*` keys)
 * and drop it from the local manifest. The shared viewer bundle (`assets/*`)
 * and commit-keyed live previews (`p/<sha>/*`) are left in place — they're
 * immutable and may be shared by other published canvases.
 */
export async function unpublishCanvas(opts: UnpublishOptions): Promise<UnpublishResult> {
  const paths = resolvePaths(opts.cwd);
  loadEnv(paths.projectDir);
  const { config } = await loadConfig(
    paths.configFile,
    opts.frameworkAlias ? { frameworkAlias: opts.frameworkAlias } : {}
  );
  if (!config.publish) throw new Error('No `publish` config in gaido.config.ts.');
  const r2 = makeR2(config.publish);
  const log = opts.log ?? (() => {});

  const manifest = readManifest(paths);
  let slugs: string[];
  if (opts.all) {
    slugs = [...new Set(Object.values(manifest).map((m) => m.publishSlug))];
  } else if (opts.canvas) {
    const hit = Object.values(manifest).find(
      (m) => m.publishSlug === opts.canvas || m.slug === opts.canvas
    );
    // Fall back to treating the arg as a raw publishSlug if it's not in the manifest.
    slugs = [hit?.publishSlug ?? opts.canvas];
  } else {
    throw new Error('Specify a canvas (slug) or --all.');
  }

  const removed: UnpublishResult['removed'] = [];
  for (const slug of slugs) {
    if (slug === 'assets' || slug === 'p') continue; // never touch shared prefixes
    const keys = await listKeys(r2, config.publish.r2.bucket, `${slug}/`);
    for (const key of keys) {
      await deleteKey(r2, config.publish.r2.bucket, key);
      log(`  ✗ ${key}`);
    }
    dropManifestByPublishSlug(paths, slug);
    removed.push({ publishSlug: slug, objects: keys.length });
  }
  return { removed };
}

async function listKeys(
  r2: { client: AwsClient; base: string },
  bucket: string,
  prefix: string
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const u = new URL(`${r2.base}/${bucket}`);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix);
    if (token) u.searchParams.set('continuation-token', token);
    const res = await r2.client.fetch(u.toString(), { method: 'GET' });
    if (!res.ok) throw new Error(`R2 list ${prefix} → ${res.status} ${res.statusText}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1] ?? ''));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (token);
  return keys;
}

async function deleteKey(
  r2: { client: AwsClient; base: string },
  bucket: string,
  key: string
): Promise<void> {
  const res = await r2.client.fetch(`${r2.base}/${bucket}/${key}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete ${key} → ${res.status} ${res.statusText}`);
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Locate a static viewer build (`vite build` with VITE_GAIDO_STATIC=1). */
function resolveViewerDist(override?: string): string {
  const candidates = [
    override,
    process.env.GAIDO_VIEWER_DIST,
    // Monorepo dev: apps/server/src → apps/web/dist-static
    path.resolve(here, '..', '..', 'web', 'dist-static'),
    // Bundled in the published server package (packaging TODO).
    path.resolve(here, '..', 'web-dist-static'),
  ].filter((c): c is string => !!c);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error(
    'Static viewer build not found. Build it with ' +
      '`pnpm --filter @gaido/web build:static`, or pass --viewer-dist <path> ' +
      '(or set GAIDO_VIEWER_DIST).'
  );
}

/** A coarse build id for the snapshot — the first hashed JS asset's filename. */
function viewerBuildId(viewerDist: string): string | undefined {
  const assets = path.join(viewerDist, 'assets');
  if (!fs.existsSync(assets)) return undefined;
  const js = fs.readdirSync(assets).find((f) => f.endsWith('.js'));
  return js;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
