import { writeFile, rename } from 'node:fs/promises';
import { validateConfig } from './proxy.js';
import { checkOrigin } from './health.js';
import { clusterStatus, setSynchronous, createSlot, dropSlot, promote, follow, DbError } from './db.js';

const json = (value, status = 200) => Response.json(value, { status });
const error = (code, message, status) => json({ error: code, message }, status);

async function readJson(req, limit = 65536) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

/**
 * Admin API, served only on the UI port and protected by x-admin-token (a header, so browsers cannot forge it cross-site).
 * `agent` holds the shared mutable state: config, pool, telemetry, history, configPath and runChecks().
 */
export function createAdmin(agent) {
  let updating = false;
  const database = () => {
    if (!agent.config.database) throw new DbError('database_not_configured', 'Add a "database" section to the configuration', 404);
    return agent.config.database;
  };
  const dbAction = action => async req => json(await action(database(), await readJson(req)));
  const telegramRoute = id => {
    const route = agent.config.webhooks?.find(item => item.id === id && item.provider === 'telegram');
    if (!route) throw Object.assign(new Error('Unknown Telegram webhook'), { status: 404 });
    return route;
  };

  const routes = {
    'GET /admin/status': async () => json({
      node: agent.nodeId, startedAt: agent.telemetry.startedAt, version: agent.version,
      edgeAuthDisabled: agent.edgeAuthDisabled, config: agent.config,
      origins: agent.pool.snapshot(agent.config), traffic: agent.telemetry.totals(),
      webhooks: (agent.config.webhooks || []).map(route => ({
        id: route.id, secretConfigured: !!process.env[route.secretEnv],
        botTokenConfigured: !!(route.botTokenEnv && process.env[route.botTokenEnv]), ...agent.webhookStats.get(route.id)
      }))
    }),
    'GET /admin/webhooks/telegram': async (req, url) => json(await telegramInfo(telegramRoute(url.searchParams.get('id')))),
    'POST /admin/webhooks/telegram': async req => {
      const body = await readJson(req);
      return json(await telegramSetWebhook(telegramRoute(body.id), body));
    },
    'GET /admin/traffic': async () => json({ series: agent.telemetry.series(), log: agent.telemetry.recent(200) }),
    'POST /admin/health/check': async () => { await agent.runChecks(); return json({ origins: agent.pool.snapshot(agent.config) }); },
    'GET /admin/config/history': async () => json({ history: agent.history }),
    'POST /admin/config/validate': async req => {
      try { validateConfig(await readJson(req)); return json({ valid: true }); }
      catch (failure) { if (failure.status) throw failure; return json({ valid: false, message: failure.message }); }
    },
    'PUT /admin/config': async req => {
      if (updating) return error('update_in_progress', 'Another update is running', 409);
      updating = true;
      try {
        let next;
        try { next = validateConfig(await readJson(req)); }
        catch (failure) { if (failure.status) throw failure; return error('invalid_configuration', failure.message, 400); }
        if (next.revision <= agent.config.revision) return error('revision_must_increase', `Current revision is ${agent.config.revision}`, 409);
        await writeFile(agent.configPath + '.tmp', JSON.stringify(next, null, 2));
        await rename(agent.configPath + '.tmp', agent.configPath);
        agent.apply(next);
        return json({ applied: true, revision: next.revision });
      } finally { updating = false; }
    },
    'GET /admin/db/status': async () => json(await clusterStatus(database())),
    'POST /admin/db/sync': dbAction(setSynchronous),
    'POST /admin/db/slots': dbAction(createSlot),
    'DELETE /admin/db/slots': dbAction(dropSlot),
    'POST /admin/db/promote': dbAction(promote),
    'POST /admin/db/follow': dbAction(follow)
  };

  return async (req, url) => {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return error('not_found', 'Unknown admin endpoint', 404);
    try { return await route(req, url); }
    catch (failure) {
      if (failure instanceof DbError) return error(failure.code, failure.message, failure.status);
      if (failure.status) return error('bad_request', failure.message, failure.status);
      // Connection-level PostgreSQL errors carry a code; report the message, which never contains credentials.
      if (failure.code) return error('database_error', failure.message.slice(0, 300), 502);
      throw failure;
    }
  };
}

export async function checkAll(config, pool) {
  const results = await Promise.all(config.origins.map(origin => checkOrigin(origin, config.timeoutMs)));
  for (const result of results) pool.checked(result, config);
  return results;
}

// Telegram Bot API calls run on the agent, so the bot token and the webhook secret never reach the browser.
async function telegram(route, method, params) {
  const token = route.botTokenEnv && process.env[route.botTokenEnv];
  if (!token) throw Object.assign(new Error(`Set ${route.botTokenEnv || 'botTokenEnv'} to use the Telegram API from the panel`), { status: 409 });
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  let response;
  try {
    response = await fetch(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(10000) });
  } catch { throw Object.assign(new Error('Telegram API is unreachable from this agent'), { status: 502 }); }
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new Error(`Telegram: ${data.description || 'HTTP ' + response.status}`), { status: 502 });
  return data.result;
}

async function telegramInfo(route) {
  const info = await telegram(route, 'getWebhookInfo');
  let pathMatches = null;
  try { pathMatches = info.url ? new URL(info.url).pathname === route.path : null; } catch {}
  return {
    url: info.url || '', pathMatches, pendingUpdates: info.pending_update_count ?? 0, ipAddress: info.ip_address || null,
    lastErrorAt: info.last_error_date ? info.last_error_date * 1000 : null, lastError: info.last_error_message || null,
    lastSyncErrorAt: info.last_synchronization_error_date ? info.last_synchronization_error_date * 1000 : null,
    maxConnections: info.max_connections ?? null, allowedUpdates: info.allowed_updates || null
  };
}

async function telegramSetWebhook(route, { publicUrl, dropPendingUpdates = false }) {
  let base;
  try { base = new URL(publicUrl); } catch { throw Object.assign(new Error('Invalid public URL'), { status: 400 }); }
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.username) throw Object.assign(new Error('Telegram requires an https:// base address without a path'), { status: 400 });
  const secret = process.env[route.secretEnv];
  if (!secret) throw Object.assign(new Error(`Set ${route.secretEnv} first`), { status: 409 });
  // Telegram accepts 1–256 characters of A-Z, a-z, 0-9, _ and -.
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw Object.assign(new Error(`${route.secretEnv} may contain only A-Z, a-z, 0-9, _ and - (up to 256)`), { status: 409 });
  const url = new URL(route.path, base).href;
  await telegram(route, 'setWebhook', { url, secret_token: secret, drop_pending_updates: dropPendingUpdates === true });
  return { url, ...(await telegramInfo(route)) };
}
