const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const url = req.url;

  // Health check
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  let targetHost, targetPath;

  if (url.startsWith('/telegram/')) {
    targetHost = 'api.telegram.org';
    targetPath = url.substring(9); // remove '/telegram'
  } else if (url.startsWith('/gemini/')) {
    targetHost = 'generativelanguage.googleapis.com';
    targetPath = url.substring(7); // remove '/gemini'
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Build headers - only forward safe headers
  const headers = {
    'host': targetHost,
    'content-type': req.headers['content-type'] || 'application/json',
    'accept': req.headers['accept'] || '*/*',
    'user-agent': 'api-proxy/1.0',
  };
  if (req.headers['content-length']) {
    headers['content-length'] = req.headers['content-length'];
  }

  const options = {
    hostname: targetHost,
    port: 443,
    path: targetPath,
    method: req.method,
    headers: headers,
  };

  console.log(`[${new Date().toISOString()}] ${req.method} ${url} -> https://${targetHost}${targetPath}`);

  const proxyReq = https.request(options, (proxyRes) => {
    // Remove hop-by-hop headers
    const respHeaders = { ...proxyRes.headers };
    delete respHeaders['transfer-encoding'];
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error(`[${new Date().toISOString()}] ERROR: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + e.message);
    }
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`API Proxy running on port ${PORT}`);
});
