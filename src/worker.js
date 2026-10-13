import { proxy, validateConfig } from './proxy.js';
import { OriginPool } from './balancer.js';
import { findWebhook, verifyWebhook } from './webhooks.js';

// Health state lives as long as the isolate. Isolates are reused across many requests, so a failed origin is skipped
// quickly in practice; it is not shared between Cloudflare locations (that would need a Durable Object).
const pool = new OriginPool();
let cached = { source: null, config: null };
function config(env) {
  if (cached.source !== env.APP_CONFIG) { cached = { source: env.APP_CONFIG, config: validateConfig(JSON.parse(env.APP_CONFIG)) }; pool.sync(cached.config); }
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

export default {
  async fetch(request, env) {
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
    } else if (!tokenOk) return new Response('Unauthorized', { status: 401 });
    return proxy(request, current, fetch, { originToken: env.ORIGIN_TOKEN, pool, clientIp, signal: request.signal });
  }
};
