# Gaido publishing — Cloudflare Worker + R2

Single-origin static host for published canvases. One Cloudflare Worker
(`src/worker.js`) sits in front of one R2 bucket and serves objects whose keys
mirror the URL path. The `gaido publish` command uploads those keys; the Worker
just serves bytes.

Everything below is a **one-time** setup. After it's standing, publishing is
just `gaido publish` — no infra touches.

You need the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
CLI and a Cloudflare account whose zone (e.g. `gaido.ai`) is already on
Cloudflare DNS.

```sh
npm i -g wrangler   # or: pnpm add -g wrangler
wrangler login
```

The examples use `graphs.gaido.ai` as the public domain and `gaido-graphs` as
the bucket — substitute your own.

## What gets served

R2 object keys mirror the URL path 1:1. `gaido publish` writes exactly these
keys; the Worker resolves them:

| URL                                | R2 key                        | Cache              |
| ---------------------------------- | ----------------------------- | ------------------ |
| `/<slug>` or `/<slug>/`            | `<slug>/index.html`           | 60s, revalidate    |
| `/assets/<file>`                   | `assets/<file>`               | immutable, 1y      |
| `/<slug>/artifacts/<id><ext>`      | `<slug>/artifacts/<id><ext>`  | immutable, 1y      |
| `/p/<sha>/...` and `/p/<sha>/`     | `p/<sha>/...` (→ `index.html`)| immutable, 1y      |

The rule: a path whose last segment has no file extension is resolved to
`<path>/index.html` (so `/<slug>`, `/<slug>/`, and `/p/<sha>/` all land on their
`index.html`); anything with an extension is served literally. `/` returns a
minimal 404 — there is no index/listing yet.

## 1. Create the R2 bucket

```sh
wrangler r2 bucket create gaido-graphs
```

Set the same name in `wrangler.toml` under `[[r2_buckets]].bucket_name` and in
the `GAIDO_R2_BUCKET` env var below.

## 2. Create an R2 S3 API token (upload credentials)

`gaido publish` uploads to R2 over the S3-compatible API, so it needs an
**Access Key ID + Secret** (not a Worker/Wrangler token):

Cloudflare Dashboard → **R2** → **Manage R2 API Tokens** → **Create API Token**

- Permission: **Object Read & Write**
- Scope: this one bucket (`gaido-graphs`) is enough
- Copy the **Access Key ID** and **Secret Access Key** (the secret is shown once)

You also need your **Account ID** (R2 overview page, or `wrangler whoami`).

Put these in `~/.gaido/.env` (shared across projects) or the project `.env`
(project values override) — the same files Gaido already loads at startup:

```sh
GAIDO_R2_ACCOUNT_ID=<your-account-id>
GAIDO_R2_BUCKET=gaido-graphs
GAIDO_R2_ACCESS_KEY_ID=<access-key-id>
GAIDO_R2_SECRET_ACCESS_KEY=<secret-access-key>
```

These are the only credentials `gaido publish` needs. They never touch
`gaido.config.ts` (which only references `process.env`).

## 3. Deploy the Worker

Set `account_id` in `wrangler.toml` (`wrangler whoami` shows it), then:

```sh
cd infra/worker
wrangler deploy
```

This publishes the Worker with the `BUCKET` binding. It isn't reachable on a
nice URL yet — that's the next step.

## 4. Attach the custom domain

Bind the public hostname as a **Workers Custom Domain**. Cloudflare provisions
and renews the edge certificate automatically — it's one wildcard level under
your zone's Universal SSL (`*.gaido.ai`), so **no Advanced Certificate Manager**
is needed.

```sh
wrangler deploy --routes graphs.gaido.ai
```

(Or uncomment the `routes = [{ pattern = "graphs.gaido.ai", custom_domain = true }]`
block in `wrangler.toml` so every deploy reasserts it. Either way needs the
`gaido.ai` zone to be on this Cloudflare account.)

DNS/cert propagation is usually under a minute.

## 5. Publish

From a Gaido project (with the env vars from step 2 in place):

```sh
gaido publish <canvas>      # a single canvas by slug or id
gaido publish --all         # every canvas (no arg = the only canvas, else error)
```

`gaido publish` builds each canvas's snapshot and uploads:

- the per-canvas viewer page → `<slug>/index.html`
- the shared, content-hashed viewer bundle → `assets/<file>`
- rendered media (mp4 / png) → `<slug>/artifacts/<id><ext>`
- live per-run previews (a `git archive` of each run's commit) → `p/<sha>/...`

The Worker serves all of it. It has no knowledge of Gaido internals — it only
maps URL path → R2 key.

## Reserved slugs

Because canvas pages live directly at `/<slug>`, the top-level path segments
**`assets`** and **`p`** are reserved by the layout (shared bundle and live
previews) and **cannot be used as canvas slugs**. `gaido publish` rejects a
canvas whose published slug would be `assets` or `p`; set `publish.slug(canvas)`
in `gaido.config.ts` to remap it.

## Smoke test

After publishing at least one canvas, against the deployed domain:

```sh
# A canvas page (302/200 + text/html, short-TTL cache):
curl -sI https://graphs.gaido.ai/<slug>/ | grep -iE 'HTTP/|content-type|cache-control'

# A hashed asset (immutable cache):
curl -sI https://graphs.gaido.ai/assets/<file> | grep -iE 'HTTP/|content-type|cache-control'

# Conditional GET returns 304 when the etag matches:
ETAG=$(curl -sI https://graphs.gaido.ai/<slug>/ | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -sI -H "If-None-Match: $ETAG" https://graphs.gaido.ai/<slug>/ | head -1   # -> HTTP/2 304

# Root has no listing yet:
curl -sI https://graphs.gaido.ai/ | head -1                                    # -> HTTP/2 404
```

Expect:
- canvas page → `200`, `content-type: text/html`, `cache-control: public, max-age=60, must-revalidate`
- asset → `200`, `cache-control: public, max-age=31536000, immutable`
- conditional → `304`
- `/` → `404`
