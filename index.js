const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;

// NVIDIA 模型轮换列表（按优先级排序，首选失败时依次尝试）
const NVIDIA_FALLBACK_MODELS = [
  'qwen/qwen3.5-397b-a17b',
  'minimaxai/minimax-m2.5',
  'deepseek-ai/deepseek-v3.2',
  'qwen/qwen3.5-122b-a10b',
];

// 不健康模型记录（模型id -> 恢复时间戳）
const unhealthyModels = {};
const COOLDOWN_MS = 10 * 60 * 1000; // 10分钟冷却

function isHealthy(modelId) {
  const until = unhealthyModels[modelId];
  if (!until) return true;
  if (Date.now() > until) { delete unhealthyModels[modelId]; return true; }
  return false;
}

function markUnhealthy(modelId) {
  unhealthyModels[modelId] = Date.now() + COOLDOWN_MS;
  console.log(`[fallback] ${modelId} marked unhealthy for 10min`);
}

// 简单 HTTP 代理（返回 Promise，resolve statusCode）
function proxyRequest(method, hostname, path, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, host: hostname };
    if (bodyBuf) h['content-length'] = Buffer.byteLength(bodyBuf);
    const req = https.request({ hostname, port: 443, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 读取请求 body
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// 解析并替换 body 中的 model 字段
function replaceModel(bodyBuf, newModel) {
  try {
    const obj = JSON.parse(bodyBuf.toString());
    obj.model = newModel;
    return Buffer.from(JSON.stringify(obj));
  } catch { return bodyBuf; }
}

function getModel(bodyBuf) {
  try { return JSON.parse(bodyBuf.toString()).model || ''; } catch { return ''; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url;
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  let targetHost, targetPath;
  let isNvidia = false;

  if (url.startsWith('/telegram/')) {
    targetHost = 'api.telegram.org';
    targetPath = url.substring(9);
  } else if (url.startsWith('/gemini/')) {
    targetHost = 'generativelanguage.googleapis.com';
    targetPath = url.substring(7);
  } else if (url.startsWith('/brave/')) {
    targetHost = 'api.search.brave.com';
    targetPath = url.substring(6);
  } else if (url.startsWith('/nvidia/')) {
    targetHost = 'integrate.api.nvidia.com';
    targetPath = url.substring(7);
    isNvidia = true;
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'accept': req.headers['accept'] || '*/*',
    'user-agent': 'api-proxy/1.0',
  };
  if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];
  if (req.headers['x-goog-api-key']) headers['x-goog-api-key'] = req.headers['x-goog-api-key'];
  if (req.headers['x-subscription-token']) headers['x-subscription-token'] = req.headers['x-subscription-token'];

  // NVIDIA 路由：支持模型自动轮换（仅 /chat/completions）
  if (isNvidia && targetPath.includes('/chat/completions')) {
    const bodyBuf = await readBody(req);
    const requestedModel = getModel(bodyBuf);
    console.log(`NVIDIA ${req.method} ${targetPath} model=${requestedModel}`);

    // 构建候选模型列表：优先用请求里的模型，失败再轮换
    const candidates = [requestedModel, ...NVIDIA_FALLBACK_MODELS.filter(m => m !== requestedModel)];
    const healthyCandidates = candidates.filter(isHealthy);
    if (requestedModel && !healthyCandidates.includes(requestedModel)) {
      console.log(`[fallback] ${requestedModel} is unhealthy, skipping`);
    }

    for (const model of healthyCandidates) {
      const buf = replaceModel(bodyBuf, model);
      try {
        const r = await proxyRequest(req.method, targetHost, targetPath, headers, buf);
        if (r.statusCode >= 200 && r.statusCode < 300) {
          if (model !== requestedModel) console.log(`[fallback] switched from ${requestedModel} to ${model}`);
          const h = { ...r.headers };
          delete h['transfer-encoding'];
          res.writeHead(r.statusCode, h);
          res.end(r.body);
          return;
        }
        // 5xx 或特定 4xx 标记不健康
        if (r.statusCode === 503 || r.statusCode === 504 || r.statusCode === 429) {
          markUnhealthy(model);
          console.log(`[fallback] ${model} -> HTTP ${r.statusCode}, trying next...`);
          continue;
        }
        // 其他 4xx（如 400 Duplicate tool call）也标记不健康
        if (r.statusCode >= 400) {
          const body = r.body.toString().substring(0, 200);
          console.log(`[fallback] ${model} -> HTTP ${r.statusCode}: ${body}`);
          if (r.statusCode === 400 && body.includes('Duplicate')) {
            markUnhealthy(model);
            continue;
          }
          // 其他 4xx 直接返回（可能是请求参数问题）
          const h = { ...r.headers }; delete h['transfer-encoding'];
          res.writeHead(r.statusCode, h); res.end(r.body); return;
        }
      } catch (e) {
        console.log(`[fallback] ${model} -> error: ${e.message}, trying next...`);
        markUnhealthy(model);
      }
    }
    // 所有模型都失败
    if (!res.headersSent) { res.writeHead(502); res.end('All models unavailable'); }
    return;
  }

  // 其他路由：直接代理（流式）
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
