// Webhook routes: requests from services that cannot send x-edge-token are authenticated by the provider's own
// mechanism instead. Secrets never live in the configuration (it is shown in the panel and kept in history):
// a route names the environment variable that holds its secret.
//
// "webhooks": [
//   { "id": "telegram", "path": "/telegram/webhook", "provider": "telegram",
//     "secretEnv": "TELEGRAM_WEBHOOK_SECRET", "botTokenEnv": "TELEGRAM_BOT_TOKEN", "checkSourceIp": false }
// ]

export const providers = ['telegram'];
// https://core.telegram.org/bots/webhooks — the subnets Telegram sends webhooks from.
export const telegramNetworks = ['149.154.160.0/20', '91.108.4.0/22'];
const envName = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);

export function validateWebhooks(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Provide up to 20 webhooks');
  const ids = new Set(), paths = new Set();
  for (const route of value) {
    if (!route || typeof route.id !== 'string' || !/^[\w.-]{1,40}$/.test(route.id) || ids.has(route.id)) throw new Error('Invalid webhook id');
    if (typeof route.path !== 'string' || !/^\/[\w\-./~]{0,200}$/.test(route.path) || route.path.includes('//') || route.path.startsWith('/_edge/') || paths.has(route.path)) throw new Error('Invalid webhook path');
    if (!providers.includes(route.provider)) throw new Error('Invalid webhook provider');
    if (!envName(route.secretEnv)) throw new Error('Invalid webhook secretEnv');
    if (route.botTokenEnv !== undefined && !envName(route.botTokenEnv)) throw new Error('Invalid webhook botTokenEnv');
    if (route.checkSourceIp !== undefined && typeof route.checkSourceIp !== 'boolean') throw new Error('Invalid webhook checkSourceIp');
    ids.add(route.id); paths.add(route.path);
  }
}

export const findWebhook = (config, pathname) => config.webhooks?.find(route => route.path === pathname) || null;

function ipv4(value) {
  const match = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value || '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.some(part => part > 255) ? null : ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
export function inNetworks(ip, networks) {
  const address = ipv4(ip);
  if (address === null) return false;
  return networks.some(network => {
    const [base, bits] = network.split('/');
    const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (address & mask) === (ipv4(base) & mask);
  });
}

/**
 * Checks one delivery. `secret` is the value of route.secretEnv; `equal` is a constant-time comparison.
 * Returns null when accepted, otherwise { status, reason } — the reason is for the log, never sent to the caller.
 */
export function verifyWebhook(route, request, { secret, clientIp, equal }) {
  if (!secret) return { status: 503, reason: 'SECRET_NOT_SET' };
  if (request.method !== 'POST') return { status: 405, reason: 'METHOD' };
  if (route.provider === 'telegram') {
    if (route.checkSourceIp && !inNetworks(clientIp, telegramNetworks)) return { status: 403, reason: 'SOURCE_IP' };
    if (!equal(request.headers.get('x-telegram-bot-api-secret-token'), secret)) return { status: 401, reason: 'BAD_SECRET' };
  }
  return null;
}

/** Per-route counters for the panel. */
export class WebhookStats {
  #items = new Map();
  record(id, status, reason = null) {
    const item = this.#items.get(id) || { accepted: 0, rejected: 0, lastAt: null, lastStatus: null, lastReject: null };
    if (reason) { item.rejected++; item.lastReject = { at: Date.now(), reason }; } else item.accepted++;
    item.lastAt = Date.now(); item.lastStatus = status;
    this.#items.set(id, item);
  }
  get(id) { return this.#items.get(id) || { accepted: 0, rejected: 0, lastAt: null, lastStatus: null, lastReject: null }; }
}
