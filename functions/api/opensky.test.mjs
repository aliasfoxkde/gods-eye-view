// Contract tests for the /api/opensky Pages Function's viewport scoping —
// the body-cap/bbox-clamp sweep (docs/PLAN.md Phase 7). The handler once
// forwarded a raw `bbox=lamax,lamin,lomin,romax` passthrough (no client ever
// sent it) and fed unvalidated lat/lon strings into the upstream query; these
// pin the validated replacement.
//
// The second half pins the credit governor (CF-v1 fix, port of the dev
// middleware's field-test fix 2026-07-06): anchor-quantized per-view cache,
// single-flight coalescing, adaptive TTL, 429 cooldown, serve-stale.
//
// Run with: npm test   (node --test)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENSKY_ANCHOR_GRID_DEG,
  OPENSKY_BOX_HALF_DEG,
  OPENSKY_CACHE_MS,
  buildOpenSkyStatesUrl,
  onRequest,
  openSkyAnchor,
  openskyAdaptiveTtlMs,
  resetOpenSkyCacheForTest,
} from './opensky.js';

const queryOf = (search) => new URL(`https://example.com/api/opensky${search}`).searchParams;

beforeEach(() => resetOpenSkyCacheForTest());

test('camera lat/lon derive the ~250 km query box', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=29.4259&lon=-98.4861'));
  assert.equal(url.pathname, '/api/states/all');
  assert.equal(Number(url.searchParams.get('lamin')), 29.4259 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lamax')), 29.4259 + OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lomin')), -98.4861 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('romax')), -98.4861 + OPENSKY_BOX_HALF_DEG);
});

test('the derived box is clamped to the planet', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=89.9&lon=179.9'));
  assert.equal(Number(url.searchParams.get('lamax')), 90);
  assert.equal(Number(url.searchParams.get('romax')), 180);
  assert.ok(Number(url.searchParams.get('lamin')) > 80);
});

test('absent, malformed, and out-of-range coordinates degrade to the global fetch', () => {
  for (const search of ['', '?lat=999&lon=0', '?lat=29.4&lon=-999', '?lat=abc&lon=def', '?lat=91&lon=0', '?lat=0&lon=181']) {
    const url = buildOpenSkyStatesUrl(queryOf(search));
    assert.equal(
      url.searchParams.toString(),
      '',
      `${search || '(no query)'} must not produce a partial box`,
    );
  }
});

test('the raw bbox passthrough is gone', () => {
  // Nothing in the client ever sent it; it forwarded arbitrary strings into
  // the upstream query string.
  const url = buildOpenSkyStatesUrl(queryOf('?bbox=1,2,3,<script>'));
  assert.equal(url.searchParams.toString(), '');
});

// ── Anchor quantization: nearby cameras share one cache key ────────────────

test('anchors snap to the 0.5° grid and stay within a quarter-degree of the camera', () => {
  const a = openSkyAnchor(queryOf('?lat=29.4259&lon=-98.4861'));
  assert.equal(a.key, '29.5:-98.5');
  assert.ok(Math.abs(a.lat - 29.4259) <= OPENSKY_ANCHOR_GRID_DEG / 2);
  assert.ok(Math.abs(a.lon - -98.4861) <= OPENSKY_ANCHOR_GRID_DEG / 2);
  // A camera 0.1° away lands on the SAME anchor — that is the whole point.
  const b = openSkyAnchor(queryOf('?lat=29.49&lon=-98.55'));
  assert.equal(b.key, a.key);
  // Past the midpoint the other way lands on the neighbor anchor.
  const c = openSkyAnchor(queryOf('?lat=29.76&lon=-98.5'));
  assert.equal(c.key, '30.0:-98.5');
});

test('invalid or absent coordinates anchor to the global key', () => {
  for (const search of ['', '?lat=999&lon=0', '?lat=91&lon=0', '?lat=0&lon=181', '?lat=abc&lon=def']) {
    assert.equal(openSkyAnchor(queryOf(search)).key, 'global', search || '(no query)');
  }
});

test('the anchor box still covers the camera on both sides (clamp edges included)', () => {
  // Worst case: the camera sits half a grid-step from the anchor; the box
  // around the anchor must still contain the camera.
  for (const [lat, lon] of [[29.26, -98.74], [89.9, 179.9], [-89.9, -179.9]]) {
    const a = openSkyAnchor(queryOf(`?lat=${lat}&lon=${lon}`));
    assert.ok(a.lat >= -90 && a.lat <= 90 && a.lon >= -180 && a.lon <= 180);
    assert.ok(
      Math.abs(a.lat - lat) <= OPENSKY_ANCHOR_GRID_DEG / 2 + 1e-9,
      `lat anchor ${a.lat} within half-step of ${lat}`,
    );
    assert.ok(
      Math.abs(a.lon - lon) <= OPENSKY_ANCHOR_GRID_DEG / 2 + 1e-9,
      `lon anchor ${a.lon} within half-step of ${lon}`,
    );
  }
});

// ── onRequest handler: upstream wiring, auth, caching, failure shape ───────

/** Capture the outbound fetch; answer with a canned upstream Response. */
function stubFetch(responder) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder();
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

const get = (search) => new Request(`https://example.com/api/opensky${search}`);

test('OPTIONS is answered with a bare CORS preflight', async () => {
  const res = await onRequest({ request: new Request('https://example.com/api/opensky', { method: 'OPTIONS' }), env: {} });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Access-Control-Allow-Methods') ?? '', /GET/);
});

test('GET forwards the anchor box with the project User-Agent', async () => {
  const upstream = new Response('{}', { status: 200 });
  const fetcher = stubFetch(() => upstream);
  try {
    const res = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(res.status, 200);
    const call = fetcher.calls[0];
    // The box is built from the QUANTIZED anchor (29.5, -98.5), so every
    // sharer of the anchor fetches an identical upstream URL.
    assert.ok(call.url.includes('lamin=27'), `anchor box in upstream URL: ${call.url}`);
    assert.ok(call.url.includes('lamax=32'), `anchor box in upstream URL: ${call.url}`);
    assert.match(call.init.headers['User-Agent'] ?? '', /gods-eye-view/);
    assert.equal(call.init.headers.Authorization, undefined, 'no credentials configured, no auth header');
  } finally {
    fetcher.restore();
  }
});

test('configured credentials ride along as Basic auth', async () => {
  const fetcher = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    await onRequest({
      request: get(''),
      env: { OPENSKY_USERNAME: 'user@example.com', OPENSKY_PASSWORD: 'secret:word' },
    });
    const expected = `Basic ${btoa('user@example.com:secret:word')}`;
    assert.equal(fetcher.calls[0].init.headers.Authorization, expected);
    assert.equal(fetcher.calls[0].url, 'https://opensky-network.org/api/states/all', 'no box without coordinates');
  } finally {
    fetcher.restore();
  }
});

test('only a full credential pair authenticates', async () => {
  let i = 0;
  for (const env of [{ OPENSKY_USERNAME: 'u' }, { OPENSKY_PASSWORD: 'p' }]) {
    // Distinct anchors per case: a cached global entry would answer the
    // second case without an upstream call to inspect.
    const fetcher = stubFetch(() => new Response('{}', { status: 200 }));
    try {
      await onRequest({ request: get(`?lat=${i}&lon=0`), env });
      assert.equal(fetcher.calls[0].init.headers.Authorization, undefined, JSON.stringify(env));
    } finally {
      fetcher.restore();
    }
    i += 1;
  }
});

// ── Credit governor: cache, coalesce, adaptive TTL, cooldown, stale ────────

test('a fresh cache entry serves the second request without an upstream call', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[1]}', { status: 200 }));
  try {
    const first = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(first.headers.get('X-OpenSky-Cache'), 'MISS');
    const second = await onRequest({ request: get('?lat=29.49&lon=-98.55'), env: {} });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-OpenSky-Cache'), 'HIT', '0.1° away shares the anchor');
    assert.deepEqual(await second.json(), { states: [1] });
    assert.equal(fetcher.calls.length, 1, 'one upstream fetch for two polls');
  } finally {
    fetcher.restore();
  }
});

test('a different anchor fetches its own box', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[]}', { status: 200 }));
  try {
    await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    await onRequest({ request: get('?lat=48.85&lon=2.35'), env: {} });
    assert.equal(fetcher.calls.length, 2, 'Paris does not share Austin’s entry');
    assert.ok(fetcher.calls[1].url.includes('lamin=46.5'), 'Paris box built from its anchor');
  } finally {
    fetcher.restore();
  }
});

test('concurrent requests coalesce onto one upstream fetch', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[2]}', { status: 200 }));
  try {
    const [a, b, c] = await Promise.all([
      onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} }),
      onRequest({ request: get('?lat=29.42&lon=-98.52'), env: {} }),
      onRequest({ request: get('?lat=29.44&lon=-98.54'), env: {} }),
    ]);
    assert.equal(fetcher.calls.length, 1, 'three polls, one credit');
    assert.equal(a.headers.get('X-OpenSky-Cache'), 'MISS');
    assert.equal(b.headers.get('X-OpenSky-Cache'), 'HIT');
    assert.equal(c.headers.get('X-OpenSky-Cache'), 'HIT');
    for (const res of [a, b, c]) assert.deepEqual(await res.json(), { states: [2] });
  } finally {
    fetcher.restore();
  }
});

test('the adaptive TTL stretches as the daily budget thins', () => {
  assert.equal(openskyAdaptiveTtlMs(Number.NaN), OPENSKY_CACHE_MS, 'no header → base TTL');
  assert.equal(openskyAdaptiveTtlMs(3000), OPENSKY_CACHE_MS);
  assert.equal(openskyAdaptiveTtlMs(2000), 30_000);
  assert.equal(openskyAdaptiveTtlMs(1000), 90_000);
  assert.equal(openskyAdaptiveTtlMs(100), 300_000);
});

test('an aged entry refreshes from upstream and re-caches with the budget-thinned TTL', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[3]}', {
    status: 200,
    headers: { 'X-Rate-Limit-Remaining': '100' },
  }));
  try {
    await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    // Age the only entry past its (budget-thinned) 300 s TTL.
    const savedNow = Date.now;
    Date.now = () => savedNow() + 301_000;
    try {
      const refreshed = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.headers.get('X-OpenSky-Cache'), 'MISS', 'aged entry refreshes');
      assert.deepEqual(await refreshed.json(), { states: [3] });
      assert.equal(fetcher.calls.length, 2);
      // The refreshed entry is fresh again under the SAME skewed clock.
      const hit = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
      assert.equal(hit.headers.get('X-OpenSky-Cache'), 'HIT');
      assert.equal(fetcher.calls.length, 2, 'the 300 s adaptive TTL holds the refreshed entry');
    } finally {
      Date.now = savedNow;
    }
  } finally {
    fetcher.restore();
  }
});

test('a 429 starts a cooldown; while cooling, the last-good body is served stale', async () => {
  const good = stubFetch(() => new Response('{"states":[4]}', { status: 200 }));
  try {
    await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
  } finally {
    good.restore();
  }
  // Age the entry past its base TTL so the next poll actually attempts upstream.
  const savedNow = Date.now;
  Date.now = () => savedNow() + (OPENSKY_CACHE_MS + 1000);
  const limited = stubFetch(() => new Response('nope', {
    status: 429,
    headers: { 'X-Rate-Limit-Retry-After-Seconds': '120' },
  }));
  try {
    await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(limited.calls.length, 1, 'the 429 cost exactly one attempt');
    const stale = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(stale.status, 200, 'cooling serves last-good, not the 429');
    assert.equal(stale.headers.get('X-OpenSky-Cache'), 'STALE');
    assert.deepEqual(await stale.json(), { states: [4] });
    assert.equal(limited.calls.length, 1, 'no upstream attempts during cooldown');
  } finally {
    Date.now = savedNow;
    limited.restore();
  }
});

test('a 429 with nothing cached passes through with the retry hint', async () => {
  const limited = stubFetch(() => new Response('nope', {
    status: 429,
    headers: { 'X-Rate-Limit-Retry-After-Seconds': '90' },
  }));
  try {
    const res = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', 'failures are not edge-cached');
    assert.equal(res.headers.get('X-OpenSky-Retry-After-Seconds'), '90');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  } finally {
    limited.restore();
  }
});

test('the cooldown clamp bounds a hostile Retry-After', async () => {
  const limited = stubFetch(() => new Response('', {
    status: 429,
    headers: { 'X-Rate-Limit-Retry-After-Seconds': '3600' },
  }));
  try {
    const res = await onRequest({ request: get('?lat=10&lon=10'), env: {} });
    assert.equal(res.headers.get('X-OpenSky-Retry-After-Seconds'), '1800');
    assert.equal(await res.text(), JSON.stringify({ error: 'OpenSky rate limit reached' }));
  } finally {
    limited.restore();
  }
});

test('an upstream failure with a last-good entry serves stale; without one, the shared error shape', async () => {
  // Warm the entry, then age it past its TTL before killing the upstream.
  const good = stubFetch(() => new Response('{"states":[5]}', { status: 200 }));
  try {
    await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
  } finally {
    good.restore();
  }
  const savedNow = Date.now;
  Date.now = () => savedNow() + (OPENSKY_CACHE_MS + 1000);
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    const stale = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('X-OpenSky-Cache'), 'STALE');
    assert.equal(stale.headers.get('X-OpenSky-Stale'), '1');
    assert.equal(stale.headers.get('Cache-Control'), 'no-store');
    // The clock is mocked OPENSKY_CACHE_MS + 1000 past the cache time.
    assert.equal(stale.headers.get('X-OpenSky-Stale-Seconds'), '10');
    assert.deepEqual(await stale.json(), { states: [5] });

    const dead = await onRequest({ request: get('?lat=10&lon=10'), env: {} });
    assert.equal(dead.status, 500);
    assert.equal(dead.headers.get('Content-Type'), 'application/json');
    assert.equal(dead.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await dead.json();
    assert.match(body.error, /OpenSky proxy error/);
    assert.match(body.error, /boom/);
  } finally {
    Date.now = savedNow;
    globalThis.fetch = saved;
  }
});

test('a 200 upstream keeps the edge-cache hint and CORS shape', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[]}', { status: 200 }));
  try {
    const res = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=8, stale-while-revalidate=4');
    assert.equal(res.headers.get('Vary'), 'Accept-Encoding');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await res.json(), { states: [] });
  } finally {
    fetcher.restore();
  }
});
