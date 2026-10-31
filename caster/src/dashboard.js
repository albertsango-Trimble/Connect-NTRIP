// HTTPS-facing (via reverse proxy) API + WebSocket feed for the Trimble Connect extension.
//
// Auth: the extension sends its Trimble Connect access token. The caster checks it against
// the Trimble Connect API (/users/me) and allows the email if it's in config.adminEmails.
// A static dashboardToken can also be set for local development.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { UserError, normaliseSerial } from './devices.js';

const AUTH_CACHE_MS = 5 * 60 * 1000;

export function startDashboard({ config, state, devices }) {
  const authCache = new Map(); // sha256(token) -> { user, expires }

  async function authenticate(token) {
    if (!token) return null;
    if (config.dashboardToken && safeEqual(token, config.dashboardToken)) {
      return { email: 'dashboard-token', name: 'Dashboard token' };
    }
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const cached = authCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.user;

    let user = null;
    for (const base of config.tcApiHosts) {
      try {
        const res = await fetch(`${base}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const me = await res.json();
          const email = String(me.email || '').toLowerCase();
          if (config.adminEmails.includes(email)) {
            user = { email, name: [me.firstName, me.lastName].filter(Boolean).join(' ') || email };
          } else {
            console.warn(`Dashboard login refused for ${email || '(no email)'}: not in adminEmails`);
          }
          break;
        }
      } catch (err) {
        console.warn(`Token check against ${base} failed: ${err.message}`);
      }
    }
    if (user) authCache.set(key, { user, expires: Date.now() + AUTH_CACHE_MS });
    return user;
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new UserError('Body too large', 413);
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new UserError('Invalid JSON'); }
  }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

    try {
      if (url.pathname === '/api/health') {
        return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000) });
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await authenticate(token);
      if (!user) return send(res, 401, { error: 'Not authorised' });

      // GET /api/snapshot
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, state.snapshot());

      // GET /api/mountpoints
      if (req.method === 'GET' && url.pathname === '/api/mountpoints') {
        return send(res, 200, config.mountpoints.map(m => state.sourceView(m)));
      }

      // /api/devices[/:serial]
      if (parts[1] === 'devices') {
        const serial = parts[2] ? normaliseSerial(decodeURIComponent(parts[2])) : null;
        if (req.method === 'GET' && !serial) return send(res, 200, devices.list());
        if (req.method === 'POST' && !serial) {
          const d = devices.add(await readJson(req));
          state.event('device.added', { serial: d.serial, by: user.email });
          broadcast({ type: 'devices', devices: devices.list() });
          return send(res, 201, d);
        }
        if (req.method === 'PATCH' && serial) {
          const body = await readJson(req);
          const d = devices.update(serial, body);
          state.event('device.updated', { serial, by: user.email, fields: Object.keys(body).filter(k => k !== 'password').concat(body.password ? ['password'] : []) });
          // Kick live sessions if the device was disabled or its password changed
          if (body.enabled === false || body.password !== undefined || body.mountpoints !== undefined) {
            for (const c of state.clients.values()) if (c.serial === serial) c.close();
          }
          broadcast({ type: 'devices', devices: devices.list() });
          return send(res, 200, d);
        }
        if (req.method === 'DELETE' && serial) {
          devices.remove(serial);
          for (const c of state.clients.values()) if (c.serial === serial) c.close();
          state.event('device.removed', { serial, by: user.email });
          broadcast({ type: 'devices', devices: devices.list() });
          return send(res, 200, { ok: true });
        }
      }

      // POST /api/rovers/:id/disconnect
      if (req.method === 'POST' && parts[1] === 'rovers' && parts[3] === 'disconnect') {
        const c = state.clients.get(parts[2]);
        if (!c) return send(res, 404, { error: 'Rover not connected' });
        state.event('rover.kicked', { serial: c.serial, by: user.email });
        c.close();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof UserError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Server error' });
    }
  });

  // ---------------------------------------------------------------- WebSocket feed
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const authed = new Set();

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) {
      ws.close(4003, 'Origin not allowed');
      return;
    }
    const authTimer = setTimeout(() => ws.close(4001, 'Auth timeout'), 10_000);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth' && !authed.has(ws)) {
        const user = await authenticate(msg.token);
        clearTimeout(authTimer);
        if (!user) { ws.close(4001, 'Not authorised'); return; }
        authed.add(ws);
        ws.send(JSON.stringify({ type: 'hello', user, snapshot: state.snapshot(), devices: devices.list() }));
      }
    });
    ws.on('close', () => { clearTimeout(authTimer); authed.delete(ws); });
  });

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  // Push discrete events immediately; positions and rates once a second.
  state.on('event', ev => broadcast({ type: 'event', event: ev }));
  const dirty = new Set();
  state.on('position', c => dirty.add(c.id));
  state.on('tick', () => {
    if (!authed.size) { dirty.clear(); return; }
    const positions = [];
    for (const id of dirty) {
      const c = state.clients.get(id);
      if (c?.gga) positions.push({ id, gga: c.gga, ggaAt: c.ggaAt, point: c.track[c.track.length - 1] || null });
    }
    dirty.clear();
    broadcast({
      type: 'tick',
      serverTime: Date.now(),
      positions,
      mountpoints: config.mountpoints.map(m => state.sourceView(m)),
      rovers: [...state.clients.values()].map(c => state.clientView(c, false)),
    });
  });

  // Drop dead dashboard sockets
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000).unref();

  server.listen(config.dashboardPort, '127.0.0.1', () => {
    console.log(`Dashboard API listening on 127.0.0.1:${config.dashboardPort} (expose it via the TLS proxy)`);
  });
  return server;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
