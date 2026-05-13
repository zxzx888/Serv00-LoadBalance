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

  // websocket 请求
  const upgrade = request.headers.get('Upgrade');

  if (
    upgrade &&
    upgrade.toLowerCase() === 'websocket'
  ) {

    // websocket 不 race
    const server = randomServer(servers);

    const url = new URL(request.url);

    url.host = server;

    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  }

  // 普通 HTTP 才竞速
  const body =
    request.method === 'GET' ||
    request.method === 'HEAD'
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
      headers: request.headers,
      body,
      signal: controller.signal
    })
      .then(response => {

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        // abort losers
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

    return new Response('All servers failed', {
      status: 502
    });

  }
}
