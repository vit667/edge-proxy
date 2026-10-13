import http from 'node:http';
for (const [id, port] of [['main', 9101], ['standby', 9102], ['replica', 9103]]) {
  let healthy = true;
  http.createServer(async (req, res) => {
    if (req.url === '/demo/fail' && req.method === 'POST') healthy = false;
    if (req.url === '/demo/recover' && req.method === 'POST') healthy = true;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ node: id, healthy, method: req.method, path: req.url, body: Buffer.concat(chunks).toString() }));
  }).listen(port, '127.0.0.1', () => console.log(`${id}: http://127.0.0.1:${port}`));
}
