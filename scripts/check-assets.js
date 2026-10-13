const base = 'http://127.0.0.1:8787';
const browserHeaders = { 'accept-encoding': 'gzip, deflate, br, zstd' };
const page = await fetch(base, { headers: browserHeaders });
const html = await page.text();
if (!/<(?:!doctype|html)/i.test(html)) throw new Error('Proxy did not return decoded HTML');
console.log('HTML', page.status, page.headers.get('content-encoding') || 'identity');
const paths = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(value => /\.(css|js|png|svg|webp|ico)(?:\?|$)/.test(value)))].slice(0, 12);
for (const path of paths) {
  const url = new URL(path, base);
  if (url.origin !== base) continue;
  const response = await fetch(url, { headers: browserHeaders });
  const body = await response.arrayBuffer();
  console.log(url.pathname, response.status, response.headers.get('content-type'), response.headers.get('content-encoding') || 'identity', body.byteLength);
}
for (const host of [base, 'https://odora.uz']) {
  const response = await fetch(host + '/manifest.json');
  const text = await response.text();
  let valid = false;
  try { JSON.parse(text); valid = true; } catch {}
  console.log(host + '/manifest.json', response.status, response.headers.get('content-type'), 'validJSON=' + valid);
}
