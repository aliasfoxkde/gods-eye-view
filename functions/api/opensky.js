/**
 * Cloudflare Pages Function — /api/opensky
 * Proxies to OpenSky Network states API with optional Basic auth.
 *
 * Viewport scoping: the flights layer sends its camera position as
 * `lat`/`lon`; the handler derives a ~250 km query box. Inputs are validated
 * (finite, in range) and out-of-range/absent coordinates degrade to the
 * global states fetch — the same shape the dev middleware serves. The
 * former raw `bbox=lamax,lamin,lomin,romax` passthrough was removed: no
 * client ever sent it, and it forwarded unvalidated strings into the
 * upstream query string (the body-cap/bbox-clamp sweep, docs/PLAN.md
 * Phase 7).
 *
 * Credit governor (CF-v1 fix, port of the dev middleware's field-test
 * fix 2026-07-06 — vite/proxies/opensky.js): a global /states/all costs
 * 4 OpenSky credits and a box query 1, and the flights layer polls every
 * 15–45 s — so an unguarded handler burns the daily budget on one busy
 * viewer and the layer hard-dies until reset. Three levers, mirroring dev:
 *
 *   1. Anchor cache — camera coords quantize onto a 0.5° grid (offset
 *      ≤ 0.25°, so the served box always still covers the camera) and the
 *      response is cached per anchor for OPENSKY_CACHE_MS, with concurrent
 *      requests coalesced onto one upstream fetch (functions/_upstream.js).
 *   2. Adaptive TTL — a 200's `X-Rate-Limit-Remaining` stretches the entry's
 *      TTL (9 s → 30 s → 90 s → 300 s) as the daily budget thins.
 *   3. 429 cooldown + serve-stale — `X-Rate-Limit-Retry-After-Seconds`
 *      (clamped 30 s … 30 min) blocks upstream attempts; while cooling, or
 *      when the upstream fails with a last-good entry in hand, the cached
 *      body is served with `X-OpenSky-Stale` so the layer keeps rendering
 *      instead of dying.
 *
 * Diagnostic headers mirror the dev middleware's names (the client reads
 * `x-opensky-auth-mode-used`/`-reason` and tolerates the rest): every body
 * response carries `X-OpenSky-Cache: HIT|MISS|STALE`, stale serves add
 * `X-OpenSky-Stale`/`-Seconds`, and a passed-through 429 adds
 * `X-OpenSky-Retry-After-Seconds`.
 *
 * Contract (200/429 match the pre-governor handler; the 5xx surface is now
 * sanitized JSON like every other proxy in this repo — the old passthrough
 * leaked upstream error bodies):
 *   200 {states:[…]}                     HIT|MISS|STALE via X-OpenSky-Cache
 *   429 {error:'OpenSky rate limit reached'}  + X-OpenSky-Retry-After-Seconds
 *   502 {error:'OpenSky upstream HTTP <n>'}   upstream 5xx, nothing cached
 *   500 {error:'OpenSky proxy error: …'}      transport failure
 */
import { coalesceRequest } from '../_upstream.js';

/** Camera-position coordinates quantize into this half-width query box (deg). */
export const OPENSKY_BOX_HALF_DEG = 2.5;

/** Camera coords snap to this grid before the box (and cache key) is built. */
export const OPENSKY_ANCHOR_GRID_DEG = 0.5;

/** Base TTL for a cached upstream body (ms) — dev OPENSKY_CACHE_MS. */
export const OPENSKY_CACHE_MS = 9_000;

/** Oldest-entry eviction ceiling on the per-anchor cache (dev parity: the
 *  dev adsb.lol point cache runs 80). */
export const OPENSKY_CACHE_MAX = 80;

/** Cooldown floor/ceiling (s) applied to X-Rate-Limit-Retry-After-Seconds. */
export const OPENSKY_COOLDOWN_MIN_S = 30;
export const OPENSKY_COOLDOWN_MAX_S = 1800;

/**
 * Pick a cache TTL from the remaining daily credit budget (dev
 * `openskyAdaptiveTtlMs`). Client polls are ≥15 s apart, so tiers ≤30 s cost
 * the same hourly credits; the later tiers stretch the day.
 * @param {number} remaining - X-Rate-Limit-Remaining header value.
 * @returns {number} TTL in ms.
 */
export function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}

/** @type {Map<string, {at: number, ttlMs: number, body: string}>} anchor -> last-good body. */
const openSkyCache = new Map();

/** @type {Map<string, Promise<{status: number, body: string, staleOf?: object}>} */
const openSkyInFlight = new Map();

/** @type {number} Epoch-ms before which no upstream fetch is attempted. */
let cooldownUntil = 0;

function openSkyCachePut(key, entry) {
  openSkyCache.set(key, entry);
  if (openSkyCache.size > OPENSKY_CACHE_MAX) {
    const oldest = [...openSkyCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) openSkyCache.delete(oldest[0]);
  }
}

/**
 * Snap the requested camera position onto the anchor grid and build both the
 * cache key and the upstream box parameters from the SAME anchor, so every
 * request that maps to a key fetches an identical upstream URL.
 * @param {URLSearchParams} searchParams the incoming request's query
 * @returns {{key: string, lat: number|null, lon: number|null}} anchor info
 *   (`lat`/`lon` null = global fetch)
 */
export function openSkyAnchor(searchParams) {
  const lat = Number.parseFloat(searchParams.get('lat') ?? '');
  const lon = Number.parseFloat(searchParams.get('lon') ?? '');
  const validLat = Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const validLon = Number.isFinite(lon) && lon >= -180 && lon <= 180;
  if (!validLat || !validLon) return { key: 'global', lat: null, lon: null };
  const grid = OPENSKY_ANCHOR_GRID_DEG;
  const anchorLat = Math.round(lat / grid) * grid;
  const anchorLon = Math.round(lon / grid) * grid;
  return {
    key: `${anchorLat.toFixed(1)}:${anchorLon.toFixed(1)}`,
    lat: anchorLat,
    lon: anchorLon,
  };
}

/**
 * Build the states/all upstream query for a camera position (exact box around
 * whatever coordinates it is given — the anchor quantization happens before
 * this is called).
 * @param {URLSearchParams} searchParams the incoming request's query
 * @returns {URL} the upstream URL (global box when inputs are absent/invalid)
 */
export function buildOpenSkyStatesUrl(searchParams) {
  const url = new URL('https://opensky-network.org/api/states/all');
  const lat = Number.parseFloat(searchParams.get('lat') ?? '');
  const lon = Number.parseFloat(searchParams.get('lon') ?? '');
  const validLat = Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const validLon = Number.isFinite(lon) && lon >= -180 && lon <= 180;
  if (validLat && validLon) {
    const halfDeg = OPENSKY_BOX_HALF_DEG;
    url.searchParams.set('lamin', String(Math.max(-90, lat - halfDeg)));
    url.searchParams.set('lamax', String(Math.min(90, lat + halfDeg)));
    url.searchParams.set('lomin', String(Math.max(-180, lon - halfDeg)));
    url.searchParams.set('romax', String(Math.min(180, lon + halfDeg)));
  }
  return url;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return corsResponse();
  }

  const anchor = openSkyAnchor(new URL(request.url).searchParams);
  const searchParams = new URLSearchParams();
  if (anchor.lat !== null && anchor.lon !== null) {
    searchParams.set('lat', String(anchor.lat));
    searchParams.set('lon', String(anchor.lon));
  }
  const url = buildOpenSkyStatesUrl(searchParams);

  // Fresh cache hit → serve verbatim; nothing upstream is contacted.
  const cached = openSkyCache.get(anchor.key);
  if (cached && Date.now() - cached.at < cached.ttlMs) {
    return bodyResponse(200, cached.body, cacheHeaders('HIT'));
  }

  // Cooldown window: no upstream attempts at all — serve the last-good body
  // regardless of age, or pass the rate limit through when nothing is cached.
  const cooling = Date.now() < cooldownUntil;
  if (cooling) {
    if (cached) {
      return staleResponse(cached);
    }
    return rateLimitedResponse(Math.ceil((cooldownUntil - Date.now()) / 1000));
  }

  // Single-flight: concurrent anchors share one upstream fetch.
  const { promise, shared } = coalesceRequest(openSkyInFlight, anchor.key, () =>
    fetchOpenSky(url, env),
  );
  const outcome = await promise;

  if (outcome.status === 200) {
    openSkyCachePut(anchor.key, { at: Date.now(), ttlMs: outcome.ttlMs, body: outcome.body });
    return bodyResponse(200, outcome.body, cacheHeaders(shared ? 'HIT' : 'MISS'));
  }
  if (outcome.status === 429) {
    if (outcome.retryAfterS > 0) cooldownUntil = Date.now() + outcome.retryAfterS * 1000;
    if (cached) return staleResponse(cached);
    return rateLimitedResponse(outcome.retryAfterS);
  }
  // Other upstream failures (5xx, oversized, transport errors surface as
  // status 0): a last-good entry beats an error — "stale beats empty", as the
  // dev middleware serves it.
  if (cached) return staleResponse(cached);
  return errorResponse(
    outcome.status === 0
      ? `OpenSky proxy error: ${outcome.error || 'upstream failed'}`
      : `OpenSky upstream HTTP ${outcome.status}`,
    outcome.status === 0 ? 500 : 502,
  );
}

/** One upstream attempt. Never throws — transport errors come back as
 *  `{status: 0, error}` so the coalesced callers share one failure shape. */
async function fetchOpenSky(url, env) {
  const headers = {
    'User-Agent': 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
  };
  if (env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD) {
    headers['Authorization'] = `Basic ${btoa(`${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}`)}`;
  }
  let res;
  try {
    res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { status: 0, error: err?.message || 'upstream failed' };
  }
  if (res.status !== 200) {
    const retryAfterS = parseRetryAfterSeconds(res.headers.get('X-Rate-Limit-Retry-After-Seconds'));
    try { await res.body?.cancel(); } catch { /* no-op */ }
    return { status: res.status, retryAfterS };
  }
  // A 200 can still carry an old snapshot — dev's OPENSKY_SOURCE_STALE_MS
  // concern — but the body is what the box asked for; cache it with the
  // adaptive TTL this response's budget implies.
  const remaining = Number.parseFloat(res.headers.get('X-Rate-Limit-Remaining') ?? '');
  const ttlMs = openskyAdaptiveTtlMs(remaining);
  let body;
  try {
    body = await res.text();
  } catch (err) {
    return { status: 0, error: err?.message || 'upstream read failed' };
  }
  return { status: 200, body, ttlMs };
}

function parseRetryAfterSeconds(raw) {
  const n = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(OPENSKY_COOLDOWN_MAX_S, Math.max(OPENSKY_COOLDOWN_MIN_S, Math.round(n)));
}

/** 200 body with the shared CORS/edge headers plus the cache diagnostic. */
function bodyResponse(status, body, extra) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // Cache successful responses for 8s at CF edge, serve stale for 4s on revalidation
    'Cache-Control': 'public, max-age=8, stale-while-revalidate=4',
    Vary: 'Accept-Encoding',
    ...extra,
  };
  return new Response(body, { status, headers });
}

function cacheHeaders(cacheState) {
  return { 'X-OpenSky-Cache': cacheState };
}

/** Serve a last-good entry past its TTL: marked stale, never client-cached. */
function staleResponse(entry) {
  return bodyResponse(200, entry.body, {
    'X-OpenSky-Cache': 'STALE',
    'X-OpenSky-Stale': '1',
    'X-OpenSky-Stale-Seconds': String(Math.round((Date.now() - entry.at) / 1000)),
    'Cache-Control': 'no-store',
  });
}

/** Pass a 429 through with the cooldown the client can plan around. */
function rateLimitedResponse(retryAfterS) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (retryAfterS > 0) headers['X-OpenSky-Retry-After-Seconds'] = String(retryAfterS);
  return new Response(JSON.stringify({ error: 'OpenSky rate limit reached' }), {
    status: 429,
    headers,
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * Test-only: drop every cached entry, in-flight promise, and cooldown so a
 * test file exercises the cold path deterministically. No production code
 * path calls this.
 */
export function resetOpenSkyCacheForTest() {
  openSkyCache.clear();
  openSkyInFlight.clear();
  cooldownUntil = 0;
}
