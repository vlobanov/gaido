// Gaido static-publishing Worker.
//
// One Cloudflare Worker in front of ONE R2 bucket. Everything is served from a
// single origin (e.g. https://graphs.gaido.ai). R2 object keys mirror the URL
// path 1:1, so routing is "strip the leading slash, GET that key" — no rewrite
// tables, no compatibility surface. The `gaido publish` command writes these
// exact keys; this Worker only serves bytes.
//
// Key scheme (written by `gaido publish`, served here):
//   <slug>/index.html                 -> a published canvas viewer page   (mutable; re-publish overwrites)
//   assets/<file>                      -> shared content-hashed viewer JS/CSS bundle (immutable)
//   <slug>/artifacts/<id><ext>         -> rendered media, mp4/png          (immutable)
//   p/<sha>/<relpath>                  -> live per-run preview (git archive of a run's commit; immutable)
//
// URL -> key resolution:
//   /<slug>            and  /<slug>/            -> <slug>/index.html
//   /p/<sha>/          and  /p/<sha>           -> p/<sha>/index.html
//   /assets/app.<h>.js                          -> assets/app.<h>.js
//   /<slug>/artifacts/<id>.mp4                  -> <slug>/artifacts/<id>.mp4
//
// The rule: if the last path segment has no file extension, it's a
// directory-style request, so try "<key>/index.html" first; otherwise serve the
// literal key. Empty path ("/") has no index/listing yet -> 404.
//
// NOTE on security: per-run preview HTML (p/<sha>/...) contains arbitrary
// artist-authored JS, served on this same origin. That's an accepted tradeoff
// for own-art galleries (see docs/publishing.md). This Worker just serves bytes.

export default {
  /**
   * @param {Request} request
   * @param {{ BUCKET: R2Bucket }} env  - R2 bucket binding named BUCKET (see wrangler.toml)
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    // Only GET/HEAD make sense for a read-only static origin.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const url = new URL(request.url);

    // Derive the candidate key by stripping the single leading slash.
    // pathname is always at least "/", and decodeURIComponent turns %20 etc.
    // back into the literal bytes used as R2 keys.
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // Malformed percent-encoding -> can't be a real key.
      return notFound();
    }
    const key = pathname.replace(/^\/+/, '');

    // "/" — nothing here yet. No index page / listing in this phase.
    if (key === '') {
      return notFound();
    }

    // Decide what to actually look up.
    //
    // If the final path segment has NO extension (no "." in it), treat the
    // request as directory-style and resolve to "<key-without-trailing-slash>/index.html"
    // first. This covers /<slug>, /<slug>/, and /p/<sha>/ in one rule. We still
    // fall back to the literal key (an extensionless asset is unusual but valid).
    const lastSegment = key.split('/').pop() || '';
    const hasExtension = lastSegment.includes('.');

    let object = null;
    let servedKey = key;

    if (!hasExtension) {
      // Directory-style: prefer the index.html under this path.
      const indexKey = key.replace(/\/+$/, '') + '/index.html';
      object = await getObject(env.BUCKET, indexKey, request);
      if (object !== null) {
        servedKey = indexKey;
      } else {
        // Fall back to the literal key (e.g. an extensionless static file).
        object = await getObject(env.BUCKET, key, request);
        servedKey = key;
      }
    } else {
      // Has an extension: serve the literal key directly.
      object = await getObject(env.BUCKET, key, request);
      servedKey = key;
    }

    if (object === null) {
      return notFound();
    }

    // 304 sentinel: getObject returns this marker when R2's conditional GET
    // (onlyIf: If-None-Match) reports the client's cached etag still matches, so
    // R2 hands back metadata with no body. Reply 304 and reuse the cache headers.
    if (object === NOT_MODIFIED) {
      return new Response(null, {
        status: 304,
        headers: {
          etag: object_etag_from_request(request),
          'cache-control': cacheControlFor(servedKey),
        },
      });
    }

    const headers = new Headers();
    // R2 stores etag/httpEtag; httpEtag is already quoted for the header.
    object.writeHttpMetadata(headers); // copies any content-type/encoding the upload set
    headers.set('content-type', contentTypeFor(servedKey));
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', cacheControlFor(servedKey));

    // HEAD: same headers, no body. content-length comes from writeHttpMetadata.
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    return new Response(object.body, { status: 200, headers });
  },
};

// --- helpers -----------------------------------------------------------------

// Sentinel returned by getObject when a conditional GET matched (R2 gave us a
// body-less object). Distinct from null (true miss).
const NOT_MODIFIED = Symbol('not-modified');

/**
 * GET a key from R2, honoring If-None-Match for cheap 304s.
 *
 * Returns:
 *   - an R2ObjectBody (has `.body`) on a normal hit,
 *   - NOT_MODIFIED if the client's If-None-Match matched (R2 returned no body),
 *   - null on a miss.
 *
 * @param {R2Bucket} bucket
 * @param {string} k
 * @param {Request} request
 */
async function getObject(bucket, k, request) {
  const inm = request.headers.get('if-none-match');

  // Pass the client's validator straight to R2. When the etag matches, R2
  // returns an R2Object WITHOUT a `body` property (the conditional failed the
  // "modified" test), which is our 304 signal.
  const object = await bucket.get(k, inm ? { onlyIf: { etagMatches: inm } } : undefined);

  if (object === null) {
    return null; // miss
  }

  // R2ObjectBody has `.body`; a bare R2Object (conditional matched) does not.
  if (!('body' in object) || object.body === undefined || object.body === null) {
    return NOT_MODIFIED;
  }

  return object;
}

// Pull the etag the client sent so a 304 can echo it back. R2's etag is already
// the value we'd send; echoing If-None-Match is equivalent and avoids a second
// metadata read.
function object_etag_from_request(request) {
  return request.headers.get('if-none-match') || '';
}

/**
 * Cache-Control policy, derived from the served key.
 *
 *  - assets/*                -> immutable (content-hashed filenames)
 *  - <slug>/artifacts/*      -> immutable (content-addressed render ids)
 *  - p/*                     -> immutable (keyed by commit sha)
 *  - <slug>/index.html       -> short TTL + must-revalidate (mutable: re-publish overwrites)
 *
 * @param {string} k  the R2 key actually served
 */
function cacheControlFor(k) {
  if (k.startsWith('assets/') || k.startsWith('p/') || /\/artifacts\//.test(k)) {
    return 'public, max-age=31536000, immutable';
  }
  // A canvas page (<slug>/index.html) is mutable — re-publishing overwrites it.
  // Short TTL with revalidation keeps re-publishes visible quickly.
  return 'public, max-age=60, must-revalidate';
}

/**
 * Map a key's file extension to a content-type. Covers the formats `gaido
 * publish` uploads (viewer bundle, media, fonts, source maps).
 *
 * @param {string} k
 */
function contentTypeFor(k) {
  const dot = k.lastIndexOf('.');
  const ext = dot === -1 ? '' : k.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'map':
      // source maps are JSON
      return 'application/json; charset=utf-8';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'ico':
      return 'image/x-icon';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'woff2':
      return 'font/woff2';
    default:
      // Unknown: let the client sniff. Safer than guessing wrong for downloads.
      return 'application/octet-stream';
  }
}

/** Minimal branded 404. No index/listing exists in this phase. */
function notFound() {
  const body =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>Gaido</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html{color-scheme:dark light}body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'margin:0;min-height:100vh;display:grid;place-items:center}main{opacity:.7}</style>' +
    '</head><body><main>Gaido — nothing here.</main></body></html>';
  return new Response(body, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
