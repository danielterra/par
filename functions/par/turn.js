const ttl = 4 * 60 * 60;
const allowedUrls = new Set([
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:443?transport=udp',
  'turns:turn.cloudflare.com:443?transport=tcp',
]);

function response(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.hostname !== 'danielterra.com.br' || url.pathname !== '/par/turn') return response({}, 404);
  if (request.method !== 'POST') return response({}, 405);
  if (request.headers.get('Origin') !== url.origin || request.headers.get('X-Par-Client') !== '1') {
    return response({}, 403);
  }
  if (!env.PAR_TURN_KEY_ID || !env.PAR_TURN_KEY_TOKEN) return response({}, 503);

  try {
    const endpoint = 'https://rtc.live.cloudflare.com/v1/turn/keys/' +
      encodeURIComponent(env.PAR_TURN_KEY_ID) + '/credentials/generate-ice-servers';
    const credentials = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.PAR_TURN_KEY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(5000),
    });
    if (!credentials.ok) return response({}, 502);
    const { iceServers } = await credentials.json();
    const relay = iceServers.find(server => server.username && server.credential && Array.isArray(server.urls));
    const urls = relay?.urls.filter(value => allowedUrls.has(value));
    if (!urls?.includes('turns:turn.cloudflare.com:443?transport=tcp')) return response({}, 502);
    return response({ iceServers: [{ urls, username: relay.username, credential: relay.credential }], ttl });
  } catch {
    return response({}, 502);
  }
}
