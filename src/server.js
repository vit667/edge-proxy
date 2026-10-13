import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { proxy, validateConfig } from './proxy.js';
import { OriginPool } from './balancer.js';
import { Telemetry } from './telemetry.js';
import { createAdmin, checkAll } from './admin.js';
import { findWebhook, verifyWebhook, WebhookStats } from './webhooks.js';
import { equal, sessionKey, issueSession, clearSession, readSession, RevokedSessions, LoginLimiter, sameOrigin, loginPage, logoutPage } from './browser-auth.js';

const env = process.env;
const adminToken = env.ADMIN_TOKEN;
const edgeToken = env.EDGE_TOKEN;
if (!adminToken || !edgeToken || adminToken.length < 24 || edgeToken.length < 24) throw new Error('Set ADMIN_TOKEN and EDGE_TOKEN (at least 24 characters each)');
const secureCookies = env.PROXY_HTTPS === '1';
// Only behind a trusted reverse proxy may X-Forwarded-For / X-Forwarded-Proto from the client be believed.
const trustProxy = env.TRUST_PROXY === '1';
const key = sessionKey(edgeToken);
const revoked = new RevokedSessions();
const limiter = new LoginLimiter();
const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

const configPath = env.CONFIG_PATH || 'config.local.json';
const agent = {
  // Must differ between servers: it is also the loop marker in X-Edge-Via.
  nodeId: env.NODE_ID || hostname(),
  version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
  edgeAuthDisabled: env.EDGE_AUTH_DISABLED === '1',
  configPath,
  config: validateConfig(JSON.parse(await readFile(configPath, 'utf8'))),
  pool: new OriginPool(),
  telemetry: new Telemetry({ stdout: env.ACCESS_LOG !== '0' }),
  history: [],
  webhookStats: new WebhookStats(),
  apply(next) {
    this.config = next;
    this.pool.sync(next);
    this.history.unshift({ revision: next.revision, appliedAt: Date.now(), config: next });
    this.history.length = Math.min(this.history.length, 20);
    scheduleChecks();
  },
  checking: null,
  runChecks() { return this.checking ??= checkAll(this.config, this.pool).finally(() => { this.checking = null; }); }
};
agent.history.push({ revision: agent.config.revision, appliedAt: Date.now(), config: agent.config });
const admin = createAdmin(agent);

let checkTimer;
function scheduleChecks() {
  clearInterval(checkTimer);
  checkTimer = setInterval(() => agent.runChecks().catch(() => {}), agent.config.healthIntervalMs ?? 5000);
  checkTimer.unref();
  agent.runChecks().catch(() => {});
}

// Control panel: a static build (ui/dist) loaded into memory at startup.
const uiRoot = fileURLToPath(new URL('../ui/dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const uiAssets = new Map();
async function loadAssets(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await loadAssets(file);
    else if (types[path.extname(entry.name)]) uiAssets.set('/' + path.relative(uiRoot, file).split(path.sep).join('/'), { type: types[path.extname(entry.name)], body: await readFile(file) });
  }
}
await loadAssets(uiRoot);
const uiHeaders = { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
function uiAsset(pathname) {
  // Hashed bundles are immutable; any other path is a client-side route of the single-page app.
  const asset = uiAssets.get(pathname) || uiAssets.get('/index.html');
  if (!asset) return new Response('Control panel is not built. Run: npm run build:ui', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const cache = pathname.startsWith('/assets/') && uiAssets.has(pathname) ? 'public, max-age=31536000, immutable' : 'no-store';
  return new Response(asset.body, { headers: { ...uiHeaders, 'content-type': asset.type, 'cache-control': cache } });
}

function clientIp(req) {
  if (trustProxy) {
    // The trusted proxy (nginx: $proxy_add_x_forwarded_for) appends the address it saw; earlier entries come from the client.
    const forwarded = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
    if (forwarded) return forwarded;
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function incomingUrl(req) {
  const forwardedProto = trustProxy && req.headers['x-forwarded-proto'];
  const proto = ['http', 'https'].includes(forwardedProto) ? forwardedProto : secureCookies ? 'https' : 'http';
  return new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
}

async function readForm(req, limit = 4096) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) return null; chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

async function edgeRoute(req, url, ip) {
  if (url.pathname === '/_edge/healthz') return Response.json({ alive: true, revision: agent.config.revision });
  if (url.pathname === '/_edge/login') {
    if (req.method === 'GET') return loginPage();
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!sameOrigin(req)) return new Response('Forbidden origin', { status: 403 });
    if (!limiter.allow(ip)) return loginPage('Слишком много попыток. Повторите через несколько минут.');
    const form = await readForm(req);
    if (!form) return new Response('Payload too large', { status: 413 });
    if (!equal(form.get('token'), edgeToken)) return loginPage('Неверный EDGE_TOKEN.');
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': issueSession(key, secureCookies) } });
  }
  if (url.pathname === '/_edge/logout') {
    if (req.method === 'GET') return logoutPage();
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!sameOrigin(req)) return new Response('Forbidden origin', { status: 403 });
    const session = readSession(req.headers.cookie, key, revoked);
    if (session) revoked.add(session);
    return new Response(null, { status: 303, headers: { location: '/_edge/login', 'set-cookie': clearSession(secureCookies) } });
  }
  return new Response('Not found', { status: 404 });
}

async function webhookRoute(req, url, ip, signal, trace, route) {
  trace.webhook = route.id;
  const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
  const rejected = verifyWebhook(route, request, { secret: env[route.secretEnv], clientIp: ip, equal });
  if (rejected) {
    trace.error = rejected.reason;
    agent.webhookStats.record(route.id, rejected.status, rejected.reason);
    if (rejected.reason === 'SECRET_NOT_SET') console.error(JSON.stringify({ type: 'error', at: new Date().toISOString(), message: `Webhook ${route.id}: environment variable ${route.secretEnv} is not set` }));
    await request.body?.cancel();
    return new Response(null, { status: rejected.status });
  }
  const response = await proxy(request, agent.config, fetch, { decodedResponse: true, pool: agent.pool, clientIp: ip, signal, trace, via: [...viaChain(req), agent.nodeId] });
  agent.webhookStats.record(route.id, response.status);
  return response;
}

// Agents that back each other up mark requests with their NODE_ID; seeing our own mark means a forwarding loop.
const viaChain = req => (req.headers['x-edge-via'] || '').split(',').map(item => item.trim()).filter(Boolean).slice(-8);
const loopDetected = req => viaChain(req).includes(agent.nodeId);

async function proxyRoute(req, url, ip, signal, trace) {
  if (loopDetected(req)) { trace.error = 'LOOP'; return Response.json({ error: 'loop_detected', via: viaChain(req) }, { status: 508 }); }
  // Webhook routes authenticate with the provider's secret instead of x-edge-token.
  const route = findWebhook(agent.config, url.pathname);
  if (route) return webhookRoute(req, url, ip, signal, trace, route);
  const tokenOk = equal(req.headers['x-edge-token'], edgeToken);
  const session = !tokenOk && readSession(req.headers.cookie, key, revoked);
  if (!agent.edgeAuthDisabled && !tokenOk && !session) {
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return new Response(null, { status: 302, headers: { location: '/_edge/login' } });
    return new Response('Unauthorized', { status: 401 });
  }
  // Cookie sessions are browser sessions: unsafe methods must come from this site (CSRF).
  if (session && !safeMethods.includes(req.method) && !sameOrigin(req)) return new Response('Forbidden origin', { status: 403 });
  const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
  const response = await proxy(request, agent.config, fetch, { decodedResponse: true, pool: agent.pool, clientIp: ip, signal, trace, via: [...viaChain(req), agent.nodeId] });
  if (session) response.headers.set('cache-control', 'no-store');
  return response;
}

function createServer(isUI) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const trace = {};
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let url, response;
    const ip = clientIp(req);
    try {
      try { url = incomingUrl(req); } catch { res.writeHead(400).end(); return; }
      if (isUI) {
        if (url.pathname.startsWith('/admin/')) response = equal(req.headers['x-admin-token'], adminToken) ? await admin(req, url) : Response.json({ error: 'unauthorized' }, { status: 401 });
        else if (safeMethods.includes(req.method)) response = uiAsset(url.pathname);
        else response = new Response('Method not allowed', { status: 405 });
        if (url.pathname.startsWith('/admin/')) response.headers.set('cache-control', 'no-store');
      } else if (url.pathname.startsWith('/_edge/')) response = await edgeRoute(req, url, ip);
      else response = await proxyRoute(req, url, ip, abort.signal, trace);

      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res); else res.end();
    } catch (error) {
      if (!abort.signal.aborted) console.error(JSON.stringify({ type: 'error', at: new Date().toISOString(), path: url?.pathname, message: error.message }));
      if (!res.headersSent) res.writeHead(500); res.end();
    } finally {
      if (!isUI && url && !url.pathname.startsWith('/_edge/')) agent.telemetry.record({
        at: started, method: req.method, path: url.pathname, status: abort.signal.aborted && !res.writableFinished ? 499 : response?.status ?? 500,
        origin: trace.origin || null, attempts: trace.attempts || 0, ms: Date.now() - started, ip, error: trace.error || null, webhook: trace.webhook || null
      });
    }
  });
}

const proxyPort = Number(env.PORT || 8787);
const uiPort = Number(env.UI_PORT || 8788);
for (const port of [proxyPort, uiPort]) if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT/UI_PORT');
if (proxyPort !== 0 && proxyPort === uiPort) throw new Error('PORT and UI_PORT must be different');
const server = createServer(false);
const uiServer = createServer(true);
for (const instance of [server, uiServer]) {
  instance.requestTimeout = 0; // long uploads and downloads are allowed; headers still have to arrive in time
  instance.headersTimeout = 15000;
  instance.on('error', error => { console.error('Listener failed:', error.message); process.exit(1); });
}
for (const route of agent.config.webhooks || []) if (!env[route.secretEnv]) console.warn(`WARNING: webhook ${route.id} rejects all deliveries until ${route.secretEnv} is set.`);
if (agent.edgeAuthDisabled) console.warn('WARNING: EDGE_AUTH_DISABLED=1 — the proxy port accepts requests without a token.' + ((env.HOST || '127.0.0.1') === '127.0.0.1' ? '' : ' It is listening on ' + env.HOST + '!'));
scheduleChecks();
server.listen(proxyPort, env.HOST || '127.0.0.1', () => console.log('Edge agent listening on port ' + server.address().port));
uiServer.listen(uiPort, env.UI_HOST || '127.0.0.1', () => console.log('Control panel listening on port ' + uiServer.address().port));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(checkTimer);
  let pending = 2;
  for (const instance of [server, uiServer]) { instance.close(() => { if (--pending === 0) process.exit(0); }); instance.closeIdleConnections(); }
  // Long-lived streams must not keep the process alive forever.
  setTimeout(() => { for (const instance of [server, uiServer]) instance.closeAllConnections(); process.exit(0); }, 10000).unref();
});
