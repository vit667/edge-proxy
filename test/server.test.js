import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('agent HTTP: authentication, failover, admin isolation, atomic revision update and durable restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edge-proxy-test-'));
  let child;
  let unavailable = false;
  const primary = http.createServer((req, res) => {
    if (req.url === '/echo') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ host: req.headers['x-forwarded-host'], ip: req.headers['x-forwarded-for'] })); return; }
    res.writeHead(unavailable ? 503 : 200); res.end('main');
  });
  const secondary = http.createServer((req, res) => { res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']); res.end('standby'); });
  const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
  try {
    const mainPort = await listen(primary); const standbyPort = await listen(secondary);
    const reservation = http.createServer(); const agentPort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
    const uiReservation = http.createServer(); const uiPort = await listen(uiReservation); await new Promise(resolve => uiReservation.close(resolve));
    const config = { app: 'integration', revision: 1, timeoutMs: 500, maxBodyBytes: 1024, healthIntervalMs: 60000, origins: [{ id: 'main', priority: 1, url: `http://127.0.0.1:${mainPort}`, healthPath: '/' }, { id: 'standby', priority: 2, url: `http://127.0.0.1:${standbyPort}`, healthPath: '/' }] };
    const configPath = path.join(dir, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    const token = 'integration-test-token-123456789';
    const adminToken = 'integration-admin-token-12345678';
    const start = async () => {
      child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, CONFIG_PATH: configPath, PORT: String(agentPort), UI_PORT: String(uiPort), UI_HOST: '127.0.0.1', HOST: '127.0.0.1', EDGE_TOKEN: token, ADMIN_TOKEN: adminToken, EDGE_AUTH_DISABLED: '0', ACCESS_LOG: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000); timer.unref();
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('Edge agent') && output.includes('Control panel')) { clearTimeout(timer); resolve(); } });
        child.once('exit', () => reject(new Error('Agent exited before startup')));
      });
    };
    const stop = async () => { const exited = once(child, 'exit'); child.kill(); await exited; child = undefined; };
    await start();
    const base = `http://127.0.0.1:${agentPort}`;
    const uiBase = `http://127.0.0.1:${uiPort}`;
    const edge = { 'x-edge-token': token };
    const adminHeaders = { 'x-admin-token': adminToken, 'content-type': 'application/json' };

    // The UI port never proxies; the admin API exists only there.
    assert.notEqual(await (await fetch(uiBase + '/events', { headers: edge })).text(), 'main');
    assert.equal((await fetch(uiBase + '/admin/status')).status, 401);
    assert.equal((await fetch(uiBase + '/admin/status', { headers: { 'x-admin-token': token } })).status, 401);
    assert.equal(await (await fetch(base + '/admin/status', { headers: { ...edge, 'x-admin-token': adminToken } })).text(), 'main', 'the proxy port forwards /admin to the application');
    assert.equal((await fetch(base + '/_edge/healthz')).status, 200);

    // Token and browser-session authentication.
    assert.equal((await fetch(base + '/events')).status, 401);
    const browserVisit = await fetch(base + '/', { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(browserVisit.status, 302); assert.equal(browserVisit.headers.get('location'), '/_edge/login');
    assert.equal((await fetch(base + '/_edge/login')).status, 200);
    const loginOptions = { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' };
    assert.equal((await fetch(base + '/_edge/login', { ...loginOptions, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/_edge/login', { ...loginOptions, body: 'token=wrong' })).status, 401);
    const login = await fetch(base + '/_edge/login', loginOptions);
    assert.equal(login.status, 303);
    const session = login.headers.get('set-cookie');
    assert.match(session, /HttpOnly/); assert.match(session, /SameSite=Strict/);
    const cookie = session.split(';')[0];
    assert.equal(await (await fetch(base + '/events', { headers: { cookie } })).text(), 'main');
    assert.equal((await fetch(base + '/events', { method: 'POST', headers: { cookie }, body: 'data' })).status, 403);
    assert.equal((await fetch(base + '/events', { method: 'POST', headers: { cookie, origin: base }, body: 'data' })).status, 200);
    assert.equal((await fetch(base + '/_edge/logout', { method: 'POST', headers: { origin: base, cookie }, redirect: 'manual' })).status, 303);
    assert.equal((await fetch(base + '/events', { headers: { cookie } })).status, 401, 'logout revokes the copied cookie');

    // Forwarding headers describe the real request.
    const echo = await (await fetch(base + '/echo', { headers: { ...edge, 'x-forwarded-for': '6.6.6.6' } })).json();
    assert.equal(echo.host, `127.0.0.1:${agentPort}`); assert.equal(echo.ip, '127.0.0.1');

    // Failover and traffic accounting.
    unavailable = true;
    const result = await fetch(base + '/events', { headers: edge });
    assert.equal(await result.text(), 'standby'); assert.equal(result.headers.getSetCookie().length, 2);
    const status = await (await fetch(uiBase + '/admin/status', { headers: adminHeaders })).json();
    assert.equal(status.origins.find(origin => origin.id === 'main').lastStatus, 503);
    const traffic = await (await fetch(uiBase + '/admin/traffic', { headers: adminHeaders })).json();
    assert.equal(traffic.log[0].origin, 'standby'); assert.equal(traffic.log[0].attempts, 2);

    // Configuration updates.
    const invalid = await (await fetch(uiBase + '/admin/config/validate', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...config, timeoutMs: 5 }) })).json();
    assert.deepEqual(invalid, { valid: false, message: 'Invalid timeoutMs' });
    assert.equal((await fetch(uiBase + '/admin/config', { method: 'PUT', headers: adminHeaders, body: JSON.stringify(config) })).status, 409);
    assert.equal((await fetch(uiBase + '/admin/config', { method: 'PUT', headers: { 'x-admin-token': adminToken }, body: JSON.stringify({ ...config, revision: 2 }) })).status, 415);
    assert.equal((await fetch(uiBase + '/admin/config', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...config, revision: 2 }) })).status, 200);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).revision, 2);
    assert.equal((await (await fetch(uiBase + '/admin/config/history', { headers: adminHeaders })).json()).history[0].revision, 2);
    assert.equal((await fetch(uiBase + '/admin/db/status', { headers: adminHeaders })).status, 404, 'no database section configured');

    await stop(); await start();
    const restarted = await (await fetch(uiBase + '/admin/status', { headers: adminHeaders })).json();
    assert.equal(restarted.config.revision, 2);
    await stop();
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill(); await exited; }
    primary.closeAllConnections(); secondary.closeAllConnections();
    await Promise.all([new Promise(resolve => primary.close(resolve)), new Promise(resolve => secondary.close(resolve))]);
    await rm(dir, { recursive: true, force: true });
  }
});
