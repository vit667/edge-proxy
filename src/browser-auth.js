import { createHmac, timingSafeEqual, randomBytes, hkdfSync } from 'node:crypto';
export const sessionCookie = 'edge_proxy_session';
const lifetime = 8 * 60 * 60;
export const equal = (a, b) => { const left = Buffer.from(a || ''); const right = Buffer.from(b || ''); return left.length === right.length && timingSafeEqual(left, right); };
// The cookie is signed with a key derived from EDGE_TOKEN, never with the token itself.
export const sessionKey = token => Buffer.from(hkdfSync('sha256', token, 'edge-proxy', 'browser-session-v3', 32));
const signature = (value, key) => createHmac('sha256', key).update('edge-browser-v3:' + value).digest('base64url');

export function issueSession(key, secure = false) {
  const payload = `${Math.floor(Date.now() / 1000) + lifetime}.${randomBytes(16).toString('hex')}`;
  return `${sessionCookie}=${payload}.${signature(payload, key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure ? '; Secure' : ''}`;
}
export const clearSession = secure => `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

/** Returns { nonce, expires } for a valid, unrevoked session, otherwise null. */
export function readSession(cookies, key, revoked) {
  const value = (cookies || '').split(';').map(item => item.trim()).find(item => item.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1);
  if (!value || value.length > 200) return null;
  const [expires, nonce, sig, extra] = value.split('.');
  if (extra !== undefined || !/^\d+$/.test(expires) || !/^[a-f0-9]{32}$/.test(nonce || '') || !sig) return null;
  const remaining = Number(expires) - Math.floor(Date.now() / 1000);
  if (remaining <= 0 || remaining > lifetime || !equal(sig, signature(`${expires}.${nonce}`, key))) return null;
  if (revoked?.has(nonce)) return null;
  return { nonce, expires: Number(expires) };
}

/** Logout revokes the cookie server-side, so a copied cookie stops working too (until the agent restarts). */
export class RevokedSessions {
  #items = new Map();
  add(session) { this.#items.set(session.nonce, session.expires); this.#prune(); }
  has(nonce) { return this.#items.has(nonce); }
  #prune() { const now = Date.now() / 1000; for (const [nonce, expires] of this.#items) if (expires < now) this.#items.delete(nonce); }
}

/** Fixed-window limiter for the login form. */
export class LoginLimiter {
  #items = new Map();
  constructor(limit = 10, windowMs = 5 * 60 * 1000) { this.limit = limit; this.windowMs = windowMs; }
  allow(key) {
    const now = Date.now();
    if (this.#items.size > 10000) for (const [item, entry] of this.#items) if (entry.resetAt < now) this.#items.delete(item);
    const entry = this.#items.get(key);
    if (!entry || entry.resetAt < now) { this.#items.set(key, { count: 1, resetAt: now + this.windowMs }); return true; }
    return ++entry.count <= this.limit;
  }
}

export function sameOrigin(req) {
  try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch { return false; }
}

const pageHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Edge Proxy</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#0a0a0a;--muted:#737373;--border:#e5e5e5;--primary:#171717;--primary-fg:#fafafa;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--primary:#fafafa;--primary-fg:#171717;--danger:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;box-shadow:0 1px 2px rgb(0 0 0/.05)}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}label{display:block;font-weight:500;margin-bottom:6px}
input{width:100%;height:36px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid color-mix(in srgb,var(--fg) 25%,transparent);outline-offset:1px}
button{width:100%;height:36px;margin-top:16px;border:0;border-radius:8px;background:var(--primary);color:var(--primary-fg);font:inherit;font-weight:500;cursor:pointer}
.alert{color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 40%,transparent);border-radius:8px;padding:8px 12px;margin-bottom:16px}
.note{font-size:12px;margin:16px 0 0;text-align:center}</style></head><body><main>${body}</main></body></html>`;

export function loginPage(error = '') {
  const alert = error ? `<div class="alert" role="alert">${error}</div>` : '';
  return new Response(page('Вход', `<h1>Вход в Edge Proxy</h1><p>Введите EDGE_TOKEN, чтобы открыть приложение через прокси.</p>${alert}<form action="/_edge/login" method="post"><label for="token">EDGE_TOKEN</label><input id="token" name="token" type="password" required autocomplete="off" autofocus><button type="submit">Открыть приложение</button></form><p class="note">Вход действует 8 часов.</p>`), { status: error ? (error.includes('попыток') ? 429 : 401) : 200, headers: pageHeaders });
}

export function logoutPage() {
  return new Response(page('Выход', `<h1>Выход из Edge Proxy</h1><p>Сессия прокси будет отозвана. Вход в само приложение не затрагивается.</p><form method="post"><button type="submit">Выйти</button></form>`), { headers: pageHeaders });
}
