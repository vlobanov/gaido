# Publishing (static export to Cloudflare)

*Status: built and verified — see **Build status** at the end.* This is the how-it-works reference; **Using it** just below is the quickstart.

Publish a finished canvas as a read-only static site: `graphs.gaido.ai/<canvas-slug>`. Openable as a page, embeddable as an iframe (`?embed=1`). No editing — a publish is a frozen point-in-time snapshot.

## Using it

1. **Configure** — a `publish` block in `gaido.config.ts` (`siteUrl` + `r2`), with R2 creds in `.env` / `~/.gaido/.env`. `gaido init` scaffolds a commented block + the `GAIDO_R2_*` vars.
2. **Build the viewer** (once per release) — `pnpm --filter @gaido/web build:static` → `apps/web/dist-static`. `gaido publish` resolves it automatically (or pass `--viewer-dist`).
3. **Publish** — `gaido publish <canvas>` uploads the bundle to R2 and prints the URL. Flags: `--all`, `--out <dir>` (also write the bundle locally), `--no-upload`, `--site-url <url>` (override the origin), `--yes` (skip the source-publish confirm). **Preview a publish locally** before pushing: `gaido publish <canvas> --out /tmp/pub --no-upload --site-url http://127.0.0.1:8080`, then serve `/tmp/pub`.
4. **Remove** — `gaido unpublish <canvas>` (or `--all`) deletes that canvas's R2 objects (shared `assets/` + `p/<sha>/` are left in place).
5. **One-time infra** — deploy the Worker per `infra/worker/README.md` (create bucket → R2 S3 token → `wrangler deploy` → attach the custom domain).

## The core call: static snapshot, not a live API

The published bundle is a **versioned JSON snapshot** embedded in the page, plus blobs on R2. There is **no tRPC-serving Worker.**

The reason is longevity. A graph published today must still open in a year, after the schema and routers have moved on. A snapshot is a self-contained contract: the viewer reads a *versioned* format and migrates old snapshots forward at load time. A live API re-imports that burden — every procedure shape becomes a forever-API — for zero benefit, since nothing is editable. The only Worker is dumb static routing in front of R2 (path → object, content-type, cache, embed headers); it has no compatibility surface. R2 egress is free, which fits video and preview hosting.

## Publishable unit = canvas

A **canvas** is the unit (the whole board — all root subtrees on it), matching the existing `/c/:identifier` route, the `canvases` table, and the whole-board UI. URL is path-based: `graphs.gaido.ai/<canvas-slug>`. The public slug defaults to the canvas slug; `publish.slug(canvas)` overrides it. Slugs are assumed unique (the publisher rejects the reserved `assets` / `p`). Per-root-subtree ("graph") publishing is a later refinement on the same snapshot format, not a v1 concern.

## The snapshot format

A versioned `GaidoSnapshotV1` type lives in `packages/core/src/snapshot.ts` (so the viewer imports it — the same end-to-end-types trick as `AppRouter`). A single `buildCanvasSnapshot(db, config, canvasId, opts)` in `apps/server/src/snapshot.ts` assembles it, reusing the exact projections the read routers already do (`nodes.list`/`get`, `runs.get`/`listByNode`, `events.history`, `references.list`, `lessons.get`, `coders.list`, `system.info`) so the live path and the publish path never drift. URL shaping is injected (`opts.urls`) — the default builder emits relative paths, and `gaido publish` supplies the R2 strategy.

```ts
interface GaidoSnapshotV1 {            // packages/core/src/snapshot.ts
  snapshotVersion: 1;
  publishedAt: number;                 // stamped by the CLI at publish time
  viewerBuild?: string;                // viewer-bundle id — pin-per-snapshot escape hatch
  site?: { url?: string };             // canonical origin, for share/embed links
  canvas: SnapshotCanvas;              // { id, name, slug, publishSlug }
  nodes: SnapshotNode[];               // edges via parentId; positionX/Y + resolved coder baked
  runs: SnapshotRun[];                 // critique/message inline; configSnapshot slimmed to names
  artifacts: SnapshotArtifact[];       // video + thumbnail only; { id, runId, kind, mime, url }
  references: SnapshotReference[];      // by id/label; image url or null
  coders: { name; kind; isDefault }[]; // for coder badges
  system: { projectName; criticKind };
  rules?: string | null;               // LESSONS.md contents, if included
  events?: SnapshotEvent[];            // optional, filtered (off by default — keeps HTML small)
}
```

### Redaction is the security boundary

The read-model is already cleanly separable from orchestration state (see the column-by-column split in `packages/core/src/schema.ts`). The snapshot builder enforces it.

**Always stripped:** `nodes.sessionId`, `branchAnchorId`, `skeletonName`, `sessionPolicy`; `runs.commitSha` (used server-side at publish to archive previews, never shipped), `costUsd`/`tokensIn`/`tokensOut`; `artifacts.path`, `node_references.filePath` (absolute paths); `error.stack`; and the `agent_token` / `tool_call` / `token_usage` event kinds.

**Config-gated** (`publish.include` / `publish.redact`): `instruction` (the artist's prompts), `artistFollowUp`, the critique `proposedRules`, baked `events`.

**Transformed:** `configSnapshot` → coder/critic/renderer *names* only; absolute artifact/reference paths → single-origin URLs under `siteUrl`; `runs.previewUrl` → `${siteUrl}/p/<sha>/`.

## Viewer = `apps/web` in static mode

No data-access refactor. The web app has no repository layer and ~80 direct `trpc.*` call sites — but links are configured in exactly one place (`createTrpcClient()` in `apps/web/src/lib/trpc.ts`), so we swap there.

- **`staticLink`** (a terminating tRPC link), behind `VITE_GAIDO_STATIC=1`. Reads `window.__GAIDO_SNAPSHOT__` and re-implements the ~12 read queries against it. The ~15 mutations **throw "read-only"**; `events.subscribe` **completes immediately** (no WS). Every component stays unchanged.
- **Inline the data, don't fetch it.** Each canvas page is one `index.html` carrying `<script>window.__GAIDO_SNAPSHOT__=…</script>` plus a shared hashed viewer bundle. Instant render, no CORS on the data, iframe-friendly; re-publish rewrites only the small HTML while the immutable JS bundle is reused. This is "embed data instead of trpc," literally.
- **Read-only context** gates every mutating affordance: fork / retry / continue / switch-coder / re-render / reply / save-critique / promote-rule / delete (`Sidebar.tsx`), favorite + retry (`CoderCard`/`CritiqueCard`), relayout + create-canvas (`Toolbar`), seed (`EmptyState`), attach/remove (`ReferenceAttacher`). The `staticLink` throwing is the backstop.
- **xyflow read-only**: `nodesDraggable={false}`, `nodesConnectable={false}`; keep pan/zoom + selection so clicking a node opens the read-only sidebar.
- **EventStream**: render baked history if `include.events`, else hide. All runs are terminal at publish.

## `gaido publish` command + config

New `gaido publish [canvas]` subcommand (`apps/cli/src/bin.ts` → `apps/cli/src/commands/publish.ts` → `publishCanvas` in `apps/server/src/publish.ts`). Flow: load config/env → resolve the target canvas (arg = slug/id; default = the sole canvas, else `--all` or an error) → `buildCanvasSnapshot` with the R2 URL strategy → collect media + reference-image files + (when `livePreviews`) `git archive` each run's commit → assemble the bundle → upload to R2 via `aws4fetch` with the **page `index.html` last** (the atomic "commit" of a publish) → write `runs/.publish/manifest.json` → print the URL.

**Config** is `publish?: PublishConfig` on `GaidoConfig` (`packages/core/src/config.ts`), **process-global** like `server`/`concurrency`/`staticPreview` — added to the `Omit` in `SkeletonConfigLayer` and to `assertNoProcessGlobalFields()`. Credentials come from env (`~/.gaido/.env` / project `.env`, already loaded at startup), referenced via `process.env`.

```ts
publish: {
  // One origin serves everything: pages at /<slug>, the viewer bundle at
  // /assets/*, media at /<slug>/artifacts/*, live previews at /p/<sha>/.
  siteUrl: 'https://graphs.gaido.ai',
  r2: { accountId, bucket, accessKeyId, secretAccessKey },   // creds via env
  include: { livePreviews: false, events: false, instructions: true },
  redact: { artistFollowUp: true },            // sessionId/paths/cost always stripped
  slug: (canvas) => canvas.slug,               // public URL key; default = canvas slug
  // indexHtmlUrls: true,                       // serving from bare R2 (no Worker)? append /index.html to page + preview URLs
}
```

R2 is S3-compatible; upload via `aws4fetch` (tiny — fits the light-deps ethic behind Drizzle-over-Prisma) rather than the heavy `@aws-sdk/client-s3`. Any S3-compatible store works via `publish.r2.endpoint` (+ `region`); the upload (SigV4 PUT), list (ListObjectsV2), and delete paths are **verified end-to-end against a local MinIO** — publish → S3 → render through a Worker-equivalent proxy → `unpublish` (13 keys removed, the 9 shared `assets/`+`p/<sha>/` left intact). A git-ignored **publish manifest** at `runs/.publish/manifest.json` maps `canvasId → { publishSlug, siteUrl, publishedAt }` for idempotent re-publish and `gaido unpublish`. `gaido init` gets a commented `publish` block + R2 vars in `.env.example` (`apps/cli/src/templates.ts`). Local-preview a publish before pushing with `gaido publish <canvas> --out <dir> --no-upload --site-url http://127.0.0.1:<port>`.

## Live previews: single-origin, path-based

With `include.livePreviews: true`, each run's committed tree is published as a browsable site (the actual running HTML/canvas, not just video), so the "Open live preview" link works on the published page. Reuses `archiveCommit` (`workspace.ts`) and dedups by commit under R2 `p/<sha>/` (short sha), the same archive-a-commit model as the local `runs/.previews/<commit>/`. The snapshot rewrites each `runs.previewUrl`, so the UI link is unchanged.

Previews are served **under a path prefix on the same origin** — `${siteUrl}/p/<sha>/`, keyed by commit (short sha, deduped). No per-run subdomain, no dedicated domain, no Advanced Certificate Manager — just a path on the one host. **Validated**: a real run's archive renders correctly under a nested `/p/<sha>/` path with no `<base>` and no URL rewriting (Pixi loaded, canvas initialized, animation live), and again end-to-end through `gaido publish` → the served bundle.

Why it holds: gaido's output is a **self-contained `index.html`** — inline `<script type="module">` plus an absolute CDN URL for Pixi, zero local asset files (confirmed across the default skeleton and real run commits). Relative refs resolve against the document path, so even a future multi-file output works under the prefix as long as it avoids **root-absolute** local refs (`/app.js`), which escape the prefix to the origin root. Cheap guardrail: a skeleton / `LESSONS.md` rule "reference assets relatively, never root-absolute." No serve-time rewriting or `<base>` injection is needed today.

**Isolation.** Previews execute arbitrary artist-authored JS on the *same* origin as the viewer. That's acceptable here because a published gallery is static and holds no cookies, auth, or secrets — there's nothing on the origin for preview JS to read, and the previews are the artist's own code. If that ever changes (hosting third-party canvases, or storing anything sensitive on the origin), isolate previews with an `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`) or move them to a separate domain. Flagged, not solved. (`CLAUDE.md` is excluded from the published preview tree.)

**Live previews publish source code**, not just the video. References are already excluded from commits (`commitRun`'s `:(exclude)references`), so reference inputs don't leak — but the art's code becomes public. `gaido publish` confirms this explicitly before uploading.

## Cloudflare topology (one-time) — see `infra/worker/`

One bucket, one Worker, one origin. R2 object keys mirror URL paths so the Worker is a pure passthrough. Artifacts live in `infra/worker/`: `src/worker.js`, `wrangler.toml`, and a step-by-step `README.md` (create bucket → R2 S3 token → `wrangler deploy` → attach the custom domain, which provisions the `*.gaido.ai` cert automatically).

- **R2 keys**: `<slug>/index.html` (page), `<slug>/artifacts/*` (media), `<slug>/refs/*` (reference images), `p/<sha>/*` (live previews), shared `assets/*` (the hashed viewer bundle, built with `pnpm --filter @gaido/web build:static`).
- **Worker** on the one domain (`graphs.gaido.ai`, covered by `*.gaido.ai` Universal SSL — no ACM): serves `env.BUCKET.get(pathname)`; for an extensionless path it tries `<path>/index.html` first, so `/<slug>`, `/<slug>/`, and `/p/<sha>/` all resolve. `immutable` cache for `assets/*`, `*/artifacts/*`, and `p/*`; `max-age=60` for a canvas page; `If-None-Match` → 304.
- **Reserved slugs**: pages live at `/<slug>`, so `assets` and `p` can't be canvas slugs — the publisher rejects them.
- **No Worker?** R2 has no directory-index, so extensionless URLs (`/<slug>`, `/p/<sha>/`) 404 when served straight from a bare R2 custom domain. Set `publish.indexHtmlUrls: true` to emit `/index.html`-suffixed URLs (exact object keys R2 resolves) — you lose clean URLs and the root 404 but need no Worker. A Cloudflare URL-rewrite rule appending `/index.html` to extensionless paths is the no-code middle ground.

## Build status

All five phases are built, typecheck across all packages, and are verified (details below). Open follow-ups: ship the static viewer inside the npm package (`prepack`), a root landing/index page, `frame-ancestors` CSP, and the actual Cloudflare deploy (the user's account — `infra/worker/README.md`).

- **A. ✅ Done.** Snapshot type `GaidoSnapshotV1` (`packages/core/src/snapshot.ts`) + `buildCanvasSnapshot` with redaction + injectable URL strategy (`apps/server/src/snapshot.ts`). Typechecks; smoke-verified against the dev DB across 5 canvases with the redaction boundary holding (no session/commit/cost/path leaks). URL shaping is injected (`opts.urls`) so phase C supplies the R2/CDN strategy.
- **B. ✅ Done.** Viewer static mode behind `VITE_GAIDO_STATIC=1`. A terminating `staticLink` (`apps/web/src/lib/static-link.ts`) answers the ~12 read queries from `window.__GAIDO_SNAPSHOT__`, errors on every mutation, and leaves subscriptions idle. A `READ_ONLY` const (`lib/static.ts`) hides every mutating control across Toolbar / cards / Sidebar / ReferenceAttacher; `artifactUrl`/`referenceUrl` helpers (same file) resolve ids to snapshot URLs in place of the ~6 inline `${httpUrl}/artifacts/${id}` sites. The xyflow graph was already read-only (`nodesDraggable={false}`, no `onNodesChange`/`onConnect`), so it needed no changes. `sessionPolicy` was added back to the snapshot — the config card displays it. Verified against a real test-project snapshot in a Playwright-driven static build: 12 nodes render, both coder and critique sidebars open fully read-only (only `close`), the OUTPUT video loads from the snapshot's artifact URL, and the only console noise is favicon 404s.
- **C. ✅ Done.** `PublishConfig` (process-global, rejected in skeleton overlays); `gaido publish [canvas] [--all] [--out <dir>] [--no-upload] [--site-url <url>] [--yes]` → `apps/cli/src/commands/publish.ts` → `publishCanvas` (`apps/server/src/publish.ts`, exposed via the `@vadimlobanov/gaido-server/publish` subpath so the web's DOM-lib typecheck never sees Node `Buffer`/R2 code). Builds the bundle (page + shared `assets/` + media + reference images + deduped `p/<sha>/` previews), uploads to R2 via `aws4fetch` (page last), writes `runs/.publish/manifest.json`. Source-publish gated behind an interactive confirm. **Verified end-to-end** two ways: (1) local bundle (`--out … --no-upload --site-url http://127.0.0.1:…`) → served read-only, stays at `/<slug>`, video `readyState 4`, `/p/<sha>/` preview renders; (2) real S3 upload to a local **MinIO** (`r2.endpoint`) → 22 objects PUT (page last), graph + media render through a Worker-equivalent proxy, then `gaido unpublish` deletes the 13 `<slug>/*` keys and leaves the shared `assets/`+`p/<sha>/` ones.
- **D. ✅ Done.** `infra/worker/` — single-origin R2 Worker (`src/worker.js`), `wrangler.toml`, and a setup `README.md`. Key scheme matches the publisher exactly. (Deploy is the user's — needs their Cloudflare account.)
- **E. ✅ Done.** `?embed=1` trims the toolbar for iframes (`EMBED` in `lib/static.ts`); the `window.__gaido` debug bridge is stripped from the published build (`!STATIC_MODE`); `gaido unpublish [canvas] [--all]` lists + deletes a canvas's R2 keys and drops its manifest entry (shared `assets/`/`p/<sha>/` left intact). Publish index/listing + `frame-ancestors` headers remain open follow-ups.

## Where this lives / doesn't

- Not in `gaido.db` — the snapshot is built from the DB at publish time, not stored.
- Not per-skeleton — `publish` is process-global deployment config, rejected from skeleton overlays.
- Credentials not in `gaido.config.ts` — in `.env` / `~/.gaido/.env`, referenced via `process.env`.
