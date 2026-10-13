import { validateDatabase, validateNode } from './db-config.js';
import { failureReason } from './health.js';
import { validateWebhooks } from './webhooks.js';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];
// Client-supplied forwarding headers are never trusted; the proxy sets its own.
const forwardingHeaders = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];
const secretHeaders = ['x-edge-token', 'x-admin-token'];
const unavailableStatuses = [502, 503, 504];
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function validateConfig(value) {
  if (!value || typeof value.app !== 'string' || !Number.isInteger(value.revision) || value.revision < 1) throw new Error('Invalid app/revision');
  if (!int(value.timeoutMs, 100, 30000)) throw new Error('Invalid timeoutMs');
  if (!int(value.maxBodyBytes, 1, 10485760)) throw new Error('Invalid maxBodyBytes');
  if (value.maxUploadBytes !== undefined && !int(value.maxUploadBytes, 1, 1073741824)) throw new Error('Invalid maxUploadBytes');
  if (value.healthIntervalMs !== undefined && !int(value.healthIntervalMs, 1000, 300000)) throw new Error('Invalid healthIntervalMs');
  for (const flag of ['retryWrites', 'exposeDebugHeaders', 'publicAccess']) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error('Invalid ' + flag);
  if (value.circuit !== undefined) {
    const { failureThreshold, cooldownMs } = value.circuit || {};
    if ((failureThreshold !== undefined && !int(failureThreshold, 1, 20)) || (cooldownMs !== undefined && !int(cooldownMs, 1000, 600000))) throw new Error('Invalid circuit');
  }
  if (!Array.isArray(value.origins) || !value.origins.length || value.origins.length > 8) throw new Error('Provide 1–8 origins');
  const ids = new Set();
  for (const origin of value.origins) {
    const url = new URL(origin.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Origin must be an HTTP(S) base URL');
    if (typeof origin.id !== 'string' || !/^[\w.-]{1,40}$/.test(origin.id) || ids.has(origin.id) || !Number.isFinite(origin.priority)) throw new Error('Invalid origin id/priority');
    if (origin.weight !== undefined && !int(origin.weight, 1, 100)) throw new Error('Invalid weight');
    for (const flag of ['readOnly', 'rewriteHost']) if (origin[flag] !== undefined && typeof origin[flag] !== 'boolean') throw new Error('Invalid ' + flag);
    if (origin.healthPath !== undefined && (typeof origin.healthPath !== 'string' || !origin.healthPath.startsWith('/') || origin.healthPath.startsWith('//') || origin.healthPath.includes('\\') || origin.healthPath.includes('#'))) throw new Error('Invalid healthPath');
    ids.add(origin.id);
  }
  if (value.database !== undefined) validateDatabase(value.database);
  if (value.webhooks !== undefined) validateWebhooks(value.webhooks);
  if (value.node !== undefined) validateNode(value.node, value);
  return structuredClone(value);
}

export function cleanHeaders(input) {
  const headers = new Headers(input);
  for (const token of (headers.get('connection') || '').split(',')) if (token.trim()) headers.delete(token.trim());
  for (const name of hopHeaders) headers.delete(name);
  return headers;
}

async function readBody(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

// Streams a body that is sent once, failing the upload if it grows beyond the limit.
function limitStream(stream, max) {
  let length = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > max) controller.error(new Error('BODY_TOO_LARGE')); else controller.enqueue(chunk);
    }
  }));
}

// Keeps redirects and cookies on the proxy host when an origin names itself, like nginx proxy_redirect/proxy_cookie_domain.
function rewriteForProxy(headers, target, incoming) {
  const location = headers.get('location');
  if (location) {
    try {
      const url = new URL(location, target);
      if (url.host === target.host) { url.protocol = incoming.protocol; url.host = incoming.host; headers.set('location', url.href); }
    } catch {}
  }
  const cookies = headers.getSetCookie();
  if (!cookies.length) return;
  headers.delete('set-cookie');
  for (const cookie of cookies) headers.append('set-cookie', cookie.replace(/;\s*domain=[^;]*/i, ''));
}


/**
 * Proxies one request. Options:
 * - pool: OriginPool for health-aware ordering (falls back to plain priority order);
 * - clientIp: becomes X-Forwarded-For / X-Real-IP;
 * - signal: client disconnect, cancels the upstream request and its body;
 * - trace: object receiving { origin, attempts, error } for logging;
 * - via: X-Edge-Via chain of the incoming request plus this node, so agents in front of each other detect loops;
 * - originToken / decodedResponse: Worker → agent token and Node fetch decoding.
 */
export async function proxy(request, config, fetcher = fetch, options = {}) {
  const { pool, trace = {} } = options;
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  // A key alone cannot make a backend idempotent. Enable this only with shared, durable backend deduplication.
  const retryable = safe || (config.retryWrites === true && !!request.headers.get('idempotency-key'));
  const candidates = config.origins.filter(o => safe || !o.readOnly);
  const origins = pool ? pool.order(candidates) : [...candidates].sort((a, b) => a.priority - b.priority);
  trace.attempts = 0;

  let body;
  if (request.body) {
    if (retryable) {
      try { body = await readBody(request.body, config.maxBodyBytes); }
      catch (error) { if (error.message === 'BODY_TOO_LARGE') return Response.json({ error: 'payload_too_large' }, { status: 413 }); throw error; }
    } else {
      // Sent once, so it can be streamed: uploads are not held in memory.
      const max = config.maxUploadBytes ?? 52428800;
      if (Number(request.headers.get('content-length')) > max) { await request.body.cancel(); return Response.json({ error: 'payload_too_large' }, { status: 413 }); }
      body = limitStream(request.body, max);
    }
  }

  const incoming = new URL(request.url);
  const headers = cleanHeaders(request.headers);
  // Browsers may offer zstd, which this Node fetch runtime does not decode.
  if (options.decodedResponse) headers.set('accept-encoding', 'gzip, deflate, br');
  for (const name of [...secretHeaders, ...forwardingHeaders]) headers.delete(name);
  const cookies = (headers.get('cookie') || '').split(';').map(item => item.trim()).filter(item => item && !item.startsWith('edge_proxy_session='));
  if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');
  if (options.originToken) headers.set('x-edge-token', options.originToken);
  if (options.clientIp) { headers.set('x-forwarded-for', options.clientIp); headers.set('x-real-ip', options.clientIp); }
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));
  headers.delete('x-edge-via');
  if (options.via) headers.set('x-edge-via', options.via.join(','));

  for (const origin of origins) {
    trace.attempts++;
    trace.origin = origin.id;
    const target = new URL(origin.url);
    // Assign the path to a fixed origin: //attacker.example must never replace the configured host.
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    // The timeout covers connecting and response headers only; a long download or SSE stream is not cut off.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Origin did not answer in time', 'TimeoutError')), config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
    const started = Date.now();
    pool?.begin(origin.id);
    try {
      const response = await fetcher(target, { method: request.method, headers, body, redirect: 'manual', signal, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
      clearTimeout(timer);
      if (unavailableStatuses.includes(response.status)) {
        pool?.failure(origin.id, `HTTP ${response.status}`, config, response.status);
        if (retryable && trace.attempts < origins.length) { await response.body?.cancel(); continue; }
      } else pool?.success(origin.id, Date.now() - started, response.status);
      const outgoing = cleanHeaders(response.headers);
      // Node's fetch decodes the body but retains upstream compression metadata.
      // Cloudflare's body handling differs, so the Node agent opts in explicitly.
      const encodings = (outgoing.get('content-encoding') || '').toLowerCase().split(',').map(value => value.trim());
      if (options.decodedResponse && encodings.every(value => ['gzip', 'x-gzip', 'deflate', 'br'].includes(value))) outgoing.delete('content-encoding');
      if (origin.rewriteHost) rewriteForProxy(outgoing, target, incoming);
      if (config.exposeDebugHeaders) { outgoing.set('x-edge-origin', origin.id); outgoing.set('x-edge-attempts', String(trace.attempts)); }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
    } catch (error) {
      clearTimeout(timer);
      if (options.signal?.aborted) { trace.error = 'CLIENT_CLOSED'; return new Response(null, { status: 499 }); }
      if (error?.message === 'BODY_TOO_LARGE' || error?.cause?.message === 'BODY_TOO_LARGE') { trace.error = 'BODY_TOO_LARGE'; return Response.json({ error: 'payload_too_large' }, { status: 413 }); }
      trace.error = failureReason(error);
      pool?.failure(origin.id, trace.error, config);
      if (!retryable) return Response.json({ error: 'delivery_unknown', message: 'The origin may have received the request. Retry with backend deduplication.' }, { status: 502 });
    }
  }
  return Response.json({ error: 'origins_unavailable', attempts: trace.attempts }, { status: 503 });
}
