const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  let targetHost, targetPath;
  if (url.startsWith('/telegram/')) {
    targetHost = 'api.telegram.org';
    targetPath = url.substring(9);
  } else if (url.startsWith('/gemini/')) {
    targetHost = 'generativelanguage.googleapis.com';
    targetPath = url.substring(7);
  } else if (url.startsWith('/brave/')) {
    targetHost = 'api.search.brave.com';
    targetPath = url.substring(6);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const headers = {
    'host': targetHost,
    'content-type': req.headers['content-type'] || 'application/json',
    'accept': req.headers['accept'] || '*/*',
    'user-agent': 'api-proxy/1.0',
  };
  if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
  if (req.headers['x-goog-api-key']) headers['x-goog-api-key'] = req.headers['x-goog-api-key'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  if (req.headers['x-subscription-token']) headers['x-subscription-token'] = req.headers['x-subscription-token'];
  console.log(`${req.method} ${url} -> https://${targetHost}${targetPath}`);
  const proxyReq = https.request({ hostname: targetHost, port: 443, path: targetPath, method: req.method, headers }, (proxyRes) => {
    const h = { ...proxyRes.headers };
    delete h['transfer-encoding'];
    res.writeHead(proxyRes.statusCode, h);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); } });
  req.pipe(proxyReq);
});
server.listen(PORT, () => console.log('Proxy on port ' + PORT));
