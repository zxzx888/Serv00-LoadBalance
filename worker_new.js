export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

// 当前轮询索引
let serverIndex = 0;

// 读取 Cloudflare Pages 节点列表
function getServers(env) {
  return env.SERVERS
    .split('\n')
    .map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''))
    .filter(Boolean);
}

// 获取轮询节点
function getNextServer(servers) {
  const server = servers[serverIndex];
  serverIndex = (serverIndex + 1) % servers.length;
  return server;
}

// 随机选择若干节点（小批量竞速）
function pickRandomServers(servers, count) {
  const shuffled = [...servers].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(count, servers.length));
}

// WebSocket 请求
async function fetchWebSocket(request, servers) {
  const server = pickRandomServers(servers, 1)[0];
  const url = new URL(request.url);
  url.host = server;
  try {
    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  } catch {
    // 尝试备用节点
    const fallback = servers.find(s => s !== server);
    if (!fallback) return new Response('All servers failed', { status: 502 });
    url.host = fallback;
    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  }
}

// HTTP 请求
async function fetchHTTP(request, servers, env) {
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
  const timeoutMs = Number(env.TIMEOUT || 5000);

  // 随机挑选 2 个节点竞速
  const candidates = pickRandomServers(servers, 2);

  const controllers = [];
  const requests = [];

  for (const server of candidates) {
    const controller = new AbortController();
    controllers.push(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const url = new URL(request.url);
    url.host = server;

    const req = fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body,
      signal: controller.signal,
      redirect: 'manual'
    })
      .then(res => {
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // abort其他请求
        for (const c of controllers) {
          if (c !== controller) c.abort();
        }
        return res;
      })
      .catch(err => {
        clearTimeout(timeout);
        throw err;
      });

    requests.push(req);
  }

  try {
    return await Promise.any(requests);
  } catch {
    return new Response('All servers failed', { status: 502 });
  }
}

// 主处理函数
async function handleRequest(request, env) {
  const servers = getServers(env);
  if (!servers.length) return new Response('No servers configured', { status: 500 });

  const upgrade = request.headers.get('Upgrade')?.toLowerCase();
  if (upgrade === 'websocket') {
    return fetchWebSocket(request, servers);
  }

  return fetchHTTP(request, servers, env);
}
