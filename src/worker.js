import { proxy, validateConfig } from './proxy.js';
import { OriginPool } from './balancer.js';
import { checkOrigin } from './health.js';
import { findWebhook, verifyWebhook } from './webhooks.js';

// Health state lives as long as the isolate. Isolates are reused across many requests, so a failed origin is skipped
// quickly in practice; it is not shared between Cloudflare locations (that would need a Durable Object).
const pool = new OriginPool();
let cached = { source: null, config: null };
let checkedAt = 0;
let checking = null;

function config(env) {
  if (cached.source !== env.APP_CONFIG) {
    cached = { source: env.APP_CONFIG, config: validateConfig(JSON.parse(env.APP_CONFIG)) };
    pool.sync(cached.config);
    checkedAt = 0;
  }
  return cached.config;
}

async function sameToken(actual, expected) {
  // Compare digests so the comparison time does not depend on where the strings differ.
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value || ''))));
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * A Worker has no background timer, so origins are checked on the way: the first request of an isolate waits for
 * the checks, later ones use the last result and refresh it in the background once it is older than the interval.
 */
function refreshHealth(current, ctx) {
  const interval = current.healthIntervalMs ?? 5000;
  if (Date.now() - checkedAt < interval) return null;
  checking ??= Promise.all(current.origins.map(origin => checkOrigin(origin, Math.min(current.timeoutMs, 3000))))
    .then(results => { for (const result of results) pool.checked(result, current); checkedAt = Date.now(); })
    .catch(() => {})
    .finally(() => { checking = null; });
  if (checkedAt === 0) return checking;
  ctx?.waitUntil?.(checking);
  return null;
}

// WebSocket: handed to the first usable origin untouched (the runtime relays the upgraded connection).
function websocket(request, current, clientIp) {
  const origin = pool.order(current.origins.filter(item => !item.readOnly))[0];
  if (!origin) return Response.json({ error: 'origins_unavailable' }, { status: 503 });
  const incoming = new URL(request.url);
  const target = new URL(origin.url);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ['x-edge-token', 'x-admin-token', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'x-edge-via']) headers.delete(name);
  if (clientIp) { headers.set('x-forwarded-for', clientIp); headers.set('x-real-ip', clientIp); }
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));
  return fetch(target, { method: request.method, headers });
}

export default {
  async fetch(request, env, ctx) {
    const tokenOk = !!env.EDGE_TOKEN && await sameToken(request.headers.get('x-edge-token'), env.EDGE_TOKEN);
    let current;
    // A broken APP_CONFIG is reported only to an authenticated caller.
    try { current = config(env); } catch { return tokenOk ? Response.json({ error: 'invalid_configuration' }, { status: 500 }) : new Response('Unauthorized', { status: 401 }); }
    const clientIp = request.headers.get('cf-connecting-ip') || undefined;
    const route = findWebhook(current, new URL(request.url).pathname);
    if (route) {
      // Digest both sides first so the synchronous verifier gets a constant-time comparison.
      const secret = env[route.secretEnv];
      const ok = await sameToken(request.headers.get('x-telegram-bot-api-secret-token'), secret);
      const rejected = verifyWebhook(route, request, { secret, clientIp, equal: () => ok });
      if (rejected) return new Response(null, { status: rejected.status });
    } else if (!current.publicAccess && !tokenOk) return new Response('Unauthorized', { status: 401 });

    await refreshHealth(current, ctx);
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') return websocket(request, current, clientIp);
    return proxy(request, current, fetch, { originToken: env.ORIGIN_TOKEN, pool, clientIp, signal: request.signal });
  }
};
