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
  return servers[
    Math.floor(Math.random() * servers.length)
  ];
}

async function handleRequest(request, env) {

  const servers = getServers(env);

  if (!servers.length) {
    return new Response('No servers configured', {
      status: 500
    });
  }

  // =========================
  // WebSocket
  // =========================

  const upgrade = request.headers.get('Upgrade');

  if (
    upgrade &&
    upgrade.toLowerCase() === 'websocket'
  ) {

    const server = randomServer(servers);

    const url = new URL(request.url);

    url.host = server;

    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  }

  // =========================
  // 带 Body 的请求
  // 直接流式转发
  // =========================

  const hasBody =
    request.method !== 'GET' &&
    request.method !== 'HEAD';

  if (hasBody) {

    const server = randomServer(servers);

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, Number(env.TIMEOUT || 5000));

    try {

      const url = new URL(request.url);

      url.host = server;

      const response = await fetch(
        url.toString(),
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      return response;

    } catch (err) {

      clearTimeout(timeout);

      return new Response(
        'Server failed',
        {
          status: 502
        }
      );

    }
  }

  // =========================
  // GET / HEAD 全竞速
  // =========================

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
      headers: request.headers,
      signal: controller.signal
    })
      .then(response => {

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        for (const c of controllers) {
          if (c !== controller) {
            c.abort();
          }
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

    return new Response(
      'All servers failed',
      {
        status: 502
      }
    );

  }
}
