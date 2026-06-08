export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

function getServers(env) {
  return env.SERVERS
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function randomServer(servers) {
  return servers[Math.floor(Math.random() * servers.length)];
}

async function handleRequest(request, env) {
  const servers = getServers(env);

  if (!servers.length) {
    return new Response('No servers configured', { status: 500 });
  }

  // 修复 Host 头
  function fixHeaders(headers, host) {
    const h = new Headers(headers);
    h.set('Host', host);
    return h;
  }

  const upgrade = request.headers.get('Upgrade');

  if (upgrade && upgrade.toLowerCase() === 'websocket') {
    const server = randomServer(servers);
    const url = new URL(request.url);
    url.host = server;

    return fetch(url.toString(), {
      method: request.method,
      headers: fixHeaders(request.headers, server),
      body: request.body
    });
  }

  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.arrayBuffer();

  const controllers = [];
  const requests = [];

  for (const server of servers) {
    const controller = new AbortController();
    controllers.push(controller);

    const timeout = setTimeout(() => {
      controller.abort();
    }, Number(env.TIMEOUT || 5000));

    const url = new URL(request.url);
    url.host = server;

    const req = fetch(url.toString(), {
      method: request.method,
      headers: fixHeaders(request.headers, server),
      body,
      signal: controller.signal
    })
      .then(response => {
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        for (const c of controllers) {
          if (c !== controller) c.abort();
        }
        return response;
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
