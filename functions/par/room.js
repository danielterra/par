const roomLife = 12 * 60 * 60 * 1000;
const peerLife = 3 * 60 * 1000;
const roomLimit = 8;
const roomPattern = /^[A-Za-z0-9_-]{16}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const schema = [
  'CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS room_expiry ON rooms(expires)',
  'CREATE TABLE IF NOT EXISTS peers (room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, token TEXT NOT NULL, name TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (room, id))',
  'CREATE TABLE IF NOT EXISTS signals (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, room TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, description TEXT NOT NULL, UNIQUE (room, sender, id), FOREIGN KEY (room, sender) REFERENCES peers(room, id) ON DELETE CASCADE, FOREIGN KEY (room, target) REFERENCES peers(room, id) ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS signal_inbox ON signals(room, target, seq)',
];

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 384000) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

function validUuid(value) {
  return typeof value === 'string' && uuidPattern.test(value);
}

function validSignal(signal) {
  const desc = signal?.description;
  if (!validUuid(signal?.id) || !validUuid(signal?.to)) return false;
  if (desc?.type === 'restart') return desc.attempt === null || validUuid(desc.attempt);
  return ['offer', 'answer'].includes(desc?.type) && typeof desc.sdp === 'string' && desc.sdp.length < 44000 &&
    (desc.attempt === undefined || validUuid(desc.attempt));
}

async function enter(db, body, now) {
  const { room, id, token, action } = body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) return json({ error: 'Informe um nome de até 40 caracteres.' }, 400);
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const statements = [];
  if (action === 'create') {
    statements.push(
      ...schema.map(sql => db.prepare(sql)),
      q('DELETE FROM rooms WHERE expires <= ?', now),
      q('INSERT OR IGNORE INTO rooms VALUES (?, ?, ?)', room, token, now + roomLife),
    );
  }
  const allowed = action === 'create' ? 'AND owner = ?' : '';
  const roomArgs = action === 'create' ? [room, now, token] : [room, now];
  statements.push(
    q('DELETE FROM peers WHERE room = ? AND seen <= ?', room, now - peerLife),
    q(`INSERT OR IGNORE INTO peers (room, id, token, name, seen)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND expires > ? ${allowed})
       AND (SELECT count(*) FROM peers WHERE room = ?) < ?`,
    room, id, token, name, now, ...roomArgs, room, roomLimit),
    q(`SELECT EXISTS (SELECT 1 FROM rooms WHERE id = ? AND expires > ? ${allowed}) AS active,
       EXISTS (SELECT 1 FROM peers WHERE room = ? AND id = ? AND token = ?) AS joined`,
    ...roomArgs, room, id, token),
  );
  const result = await db.batch(statements);
  const { active, joined } = result.at(-1).results[0];
  if (!active) return json({ error: 'Este convite expirou ou a sala não existe.' }, 404);
  if (!joined) return json({ error: 'A sala já tem oito participantes.' }, 409);
  return json({ room });
}

async function sync(db, body, now) {
  const { room, id, token, cursor, outbox } = body;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(outbox) ||
      outbox.length > roomLimit || !outbox.every(validSignal)) return json({}, 400);
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const auth = 'room = ? AND id = ? AND token = ? AND seen > ?';
  const authArgs = [room, id, token, now - peerLife];
  const active = 'EXISTS (SELECT 1 FROM rooms WHERE id = ? AND expires > ?)';
  const gate = `EXISTS (SELECT 1 FROM peers WHERE ${auth}) AND ${active}`;
  const gateArgs = [...authArgs, room, now];
  const result = await db.batch([
    q(`SELECT 1 FROM peers WHERE ${auth} AND ${active}`, ...gateArgs),
    q(`UPDATE peers SET seen = ? WHERE ${auth} AND seen < ? AND ${active}`, now, ...authArgs, now - 30000, room, now),
    q(`DELETE FROM signals WHERE room = ? AND target = ? AND seq <= ? AND ${gate}`, room, id, cursor, ...gateArgs),
    ...outbox.map(signal => q(`INSERT OR IGNORE INTO signals (id, room, sender, target, description)
       SELECT ?, ?, ?, ?, ? WHERE ${gate}
       AND EXISTS (SELECT 1 FROM peers WHERE room = ? AND id = ? AND seen > ?)
       AND (SELECT count(*) FROM signals WHERE room = ? AND sender = ?) < 32`,
    signal.id, room, id, signal.to, JSON.stringify(signal.description),
    ...gateArgs, room, signal.to, now - peerLife, room, id)),
    q(`SELECT id, name FROM peers WHERE room = ? AND id <> ? AND seen > ? AND ${gate}`, room, id, now - peerLife, ...gateArgs),
    q(`SELECT seq, sender, description FROM signals WHERE room = ? AND target = ? AND seq > ?
       AND ${gate} ORDER BY seq LIMIT 32`, room, id, cursor, ...gateArgs),
  ]);
  if (!result[0].results.length) return json({ error: 'Sua sessão expirou. Abra o convite para entrar novamente.' }, 410);
  return json({ peers: result.at(-2).results, signals: result.at(-1).results });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({}, 405);
  if (request.headers.get('Origin') !== url.origin || request.headers.get('X-Par-Client') !== '1') return json({}, 403);
  const db = env.PAR_ROOMS;
  if (!db) return json({ error: 'O serviço de salas está temporariamente indisponível.' }, 503);
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({}, 400);
  }
  if (!body || typeof body.room !== 'string' || !roomPattern.test(body.room) || !validUuid(body.id) || !validUuid(body.token)) return json({}, 400);
  const now = Date.now();
  try {
    if (body.action === 'create' || body.action === 'join') return await enter(db, body, now);
    if (body.action === 'sync') return await sync(db, body, now);
    if (body.action === 'leave') {
      await db.prepare('DELETE FROM peers WHERE room = ? AND id = ? AND token = ?').bind(body.room, body.id, body.token).run();
      return json({});
    }
    return json({}, 400);
  } catch (error) {
    if (body.action === 'join' && String(error).includes('no such table')) return json({ error: 'Esta sala não existe.' }, 404);
    console.error('Falha no serviço de salas do Par', error.message);
    return json({ error: 'Não foi possível acessar a sala. Tente novamente.' }, 503);
  }
}
