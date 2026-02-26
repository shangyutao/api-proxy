const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const ROUTES = {
  '/telegram': 'api.telegram.org',
  '/gemini': 'generativelanguage.googleapis.com',
};

const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Find matching route
  let targetHost = null;
  let targetPath = req.url;

  for (const [prefix, host] of Object.entries(ROUTES)) {
    if (req.url.startsWith(prefix + '/')) {
      targetHost = host;
      targetPath = req.url.slice(prefix.length);
      break;
    }
  }

  if (!targetHost) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Forward request
  const options = {
    hostname: targetHost,
    port: 443,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: targetHost },
  };
  delete options.headers['connection'];

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`API Proxy running on port ${PORT}`);
});
