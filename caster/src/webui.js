// Reverse proxy that lets the extension show each base receiver's own web interface.
//
// Each receiver gets its own HTTPS host, <id>.<webUi.domain> (Caddy issues the certificate on demand),
// so the receiver's pages keep working with their own absolute paths.
//
// Access: the extension asks the dashboard API (as an admin) for a one-time link that is valid for 60 s.
// Opening it sets a session cookie for that receiver host only; every request after that is proxied to
// the receiver. The receiver's own login (HTTP Basic or Digest) can be filled in by the proxy so users
// don't need the receiver password.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const START_TTL_MS = 60_000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'ntrip_webui';
const MAX_BUFFERED_BODY = 2 * 1024 * 1024;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// ---------------------------------------------------------------- signed tokens
export class Tokens {
  constructor(secret) { this.secret = secret; this.used = new Map(); }
  hmac(body) { return crypto.createHmac('sha256', this.secret).update(body).digest('base64url'); }
  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.hmac(body)}`;
  }
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(this.hmac(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  }
  /** One-time links: each nonce can be used once while it is valid. */
  consume(nonce, exp) {
    const now = Date.now();
    for (const [n, e] of this.used) if (e < now) this.used.delete(n);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, exp);
    return true;
  }
}

export function loadSecret(config) {
  if (process.env.WEBUI_SECRET) return process.env.WEBUI_SECRET;
  const file = path.join(config.dataDir, 'webui-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export function receiverHost(config, r) {
  return `${r.id}.${config.webUi.domain}`.toLowerCase();
}

export function receiverPublicUrl(config, r) {
  const tpl = config.webUi.publicUrl || `https://{id}.${config.webUi.domain}`;
  return tpl.replace('{id}', r.id).replace(/\/+$/, '');
}

/** One-time link for the extension (60 s, single use). */
export function startLink(config, tokens, r, email) {
  const exp = Date.now() + START_TTL_MS;
  const t = tokens.sign({ kind: 'start', rid: r.id, email, exp, nonce: crypto.randomBytes(9).toString('base64url') });
  return `${receiverPublicUrl(config, r)}/__ntrip_auth?t=${encodeURIComponent(t)}`;
}

// ---------------------------------------------------------------- receiver login (Basic / Digest)
class ReceiverAuth {
  constructor(r) {
    this.user = r.username || null;
    this.pass = r.password || '';
    this.mode = r.auth === 'basic' ? 'basic' : null; // learned from the receiver's 401 otherwise
    this.challenge = null;
    this.nc = 0;
  }
  get enabled() { return !!this.user; }

  header(method, uri) {
    if (!this.enabled) return null;
    if (this.mode === 'basic') return 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    if (this.mode !== 'digest' || !this.challenge) return null;
    const c = this.challenge;
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    const sha = s => crypto.createHash('sha256').update(s).digest('hex');
    const algo = (c.algorithm || 'MD5').toUpperCase();
    const H = algo.startsWith('SHA-256') ? sha : md5;
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = (++this.nc).toString(16).padStart(8, '0');
    let ha1 = H(`${this.user}:${c.realm}:${this.pass}`);
    if (algo.endsWith('-SESS')) ha1 = H(`${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = H(`${method}:${uri}`);
    const qop = c.qop ? c.qop.split(',').map(s => s.trim()).find(q => q === 'auth') : null;
    const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
    const parts = [
      `username="${this.user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`,
      c.algorithm ? `algorithm=${c.algorithm}` : null,
      c.opaque ? `opaque="${c.opaque}"` : null,
      qop ? `qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : null,
    ].filter(Boolean);
    return `Digest ${parts.join(', ')}`;
  }

  /** Learns the login scheme from a 401. Returns true if a retry with credentials makes sense. */
  learn(wwwAuthenticate) {
    if (!this.enabled || !wwwAuthenticate) return false;
    const list = Array.isArray(wwwAuthenticate) ? wwwAuthenticate : [wwwAuthenticate];
    const digest = list.find(h => /^digest\s/i.test(h));
    if (digest) {
      const params = {};
      for (const m of digest.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) params[m[1].toLowerCase()] = m[2] ?? m[3];
      const stale = String(params.stale).toLowerCase() === 'true';
      const isNew = !this.challenge || this.challenge.nonce !== params.nonce;
      this.mode = 'digest';
      this.challenge = params;
      this.nc = 0;
      return isNew || stale;
    }
    if (list.some(h => /^basic\s/i.test(h)) && this.mode !== 'basic') {
      this.mode = 'basic';
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- helpers
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function stripOurCookie(header) {
  return String(header || '').split(';').map(s => s.trim()).filter(s => s && !s.startsWith(`${COOKIE}=`)).join('; ');
}

function sessionCookie(value, secure, maxAgeMs) {
  const base = `${COOKIE}=${value}; Path=/; HttpOnly; Max-Age=${Math.round(maxAgeMs / 1000)}`;
  // Inside Trimble Connect the page is a third-party frame: it needs SameSite=None + Secure, and
  // Partitioned (CHIPS) so browsers that block third-party cookies still keep it for this embed.
  return secure ? `${base}; Secure; SameSite=None; Partitioned` : `${base}; SameSite=Lax`;
}

/** Makes the receiver's own cookies work in the embedded frame too. */
function rewriteSetCookie(c, secure) {
  let parts = c.split(';').map(s => s.trim()).filter(p => !/^(domain|samesite|secure|partitioned)\b/i.test(p));
  if (secure) parts = parts.concat(['Secure', 'SameSite=None', 'Partitioned']);
  return parts.join('; ');
}

function frameAncestors(config) {
  const list = ["'self'", 'https://*.connect.trimble.com', ...config.allowedOrigins];
  return [...new Set(list)].join(' ');
}

function htmlPage(res, status, title, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;color:#252a2e;background:#f1f1f6;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
div{max-width:440px;background:#fff;border:1px solid #e0e1e9;border-radius:8px;padding:20px 22px;line-height:1.5}h1{font-size:16px;margin:0 0 8px}</style>
<div><h1>${title}</h1>${body}</div>`);
}

// ---------------------------------------------------------------- server
export function startWebUiProxy({ config, state, tokens, receiverStore }) {
  if (!config.webUi?.domain) return null;
  // The receiver list can change while running (receivers added in the extension), so it is read live.
  // Login state is kept per receiver and started again when its address or login changes.
  const auths = new Map(); // id -> { key, auth }
  const entryFor = r => {
    const key = `${r.webUrl}|${r.username || ''}|${r.password || ''}`;
    let a = auths.get(r.id);
    if (!a || a.key !== key) { a = { key, auth: new ReceiverAuth(r) }; auths.set(r.id, a); }
    return { r, auth: a.auth };
  };
  const lookup = req => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const r = config.receivers.find(x => x.webUrl && receiverHost(config, x) === host);
    return r ? entryFor(r) : null;
  };
  /** Receivers may serve plain http or https (often with a self-signed certificate). */
  const client = target => (target.protocol === 'https:' ? https : http);
  const portOf = target => Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const isSecure = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  function session(req, entry) {
    const s = tokens.verify(parseCookies(req.headers.cookie)[COOKIE]);
    return s && s.kind === 'session' && s.rid === entry.r.id ? s : null;
  }

  function upstreamHeaders(req, target, entry, uri) {
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    for (const h of Object.keys(headers)) if (h.startsWith('x-forwarded-')) delete headers[h];
    const cookie = stripOurCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    headers.host = target.host;
    // Embedded web servers often check these against their own address.
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) {
      try { const u = new URL(headers.referer); headers.referer = target.origin + u.pathname + u.search; } catch { delete headers.referer; }
    }
    delete headers.authorization;
    const auth = entry.auth.header(req.method, uri);
    if (auth) headers.authorization = auth;
    return headers;
  }

  function fixResponseHeaders(pres, target, secure) {
    const out = {};
    for (const [k, v] of Object.entries(pres.headers)) {
      if (HOP_BY_HOP.includes(k) || k === 'x-frame-options') continue;
      out[k] = v;
    }
    // Allow framing by Trimble Connect and the extension, keeping the receiver's other CSP rules.
    const csp = pres.headers['content-security-policy'];
    const ours = `frame-ancestors ${frameAncestors(config)}`;
    out['content-security-policy'] = csp
      ? String(csp).split(';').map(s => s.trim()).filter(s => s && !/^frame-ancestors\b/i.test(s)).concat(ours).join('; ')
      : ours;
    if (out.location) {
      try {
        const loc = new URL(out.location, target.origin);
        if (loc.host === target.host) out.location = loc.pathname + loc.search + loc.hash;
      } catch { /* leave it */ }
    }
    if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map(c => rewriteSetCookie(c, secure));
    return out;
  }

  function forward(req, res, entry, body, retried = false) {
    const target = new URL(entry.r.webUrl);
    const uri = req.url;
    const headers = upstreamHeaders(req, target, entry, uri);
    if (body) headers['content-length'] = String(body.length);
    const preq = client(target).request({
      host: target.hostname, port: portOf(target), method: req.method, path: uri, headers, timeout: 30_000, rejectUnauthorized: false,
    }, pres => {
      if (pres.statusCode === 401 && !retried && body !== undefined && entry.auth.learn(pres.headers['www-authenticate'])) {
        pres.resume();
        return forward(req, res, entry, body, true);
      }
      if (pres.statusCode === 401) entry.auth.learn(pres.headers['www-authenticate']);
      res.writeHead(pres.statusCode, pres.statusMessage, fixResponseHeaders(pres, target, isSecure(req)));
      lastServed.set(entry.r.id, Date.now());
      if (state.receiverStatus.get(entry.r.id)?.reachable === false) state.setReceiverStatus(entry.r.id, { reachable: true, httpStatus: pres.statusCode });
      pres.pipe(res);
    });
    preq.on('timeout', () => preq.destroy(new Error('timeout')));
    preq.on('error', err => {
      if (res.headersSent) return res.destroy();
      htmlPage(res, 502, "The base receiver isn't answering",
        `<p>The caster couldn't reach <b>${entry.r.name || entry.r.id}</b> (${err.code || err.message}).</p><p>Check the receiver is powered and online, and that the caster can reach it at its configured address.</p>`);
    });
    if (body !== undefined) preq.end(body);
    else req.pipe(preq); // large or unknown-length uploads are streamed (no retry)
  }

  const server = http.createServer((req, res) => {
    const entry = lookup(req);
    if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Unknown receiver'); }
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/__ntrip_auth') {
      const p = tokens.verify(url.searchParams.get('t'));
      if (!p || p.kind !== 'start' || p.rid !== entry.r.id || !tokens.consume(p.nonce, p.exp)) {
        return htmlPage(res, 403, 'This link has expired', '<p>Open the base Web UI again from the NTRIP Caster extension in Trimble Connect.</p>');
      }
      const value = tokens.sign({ kind: 'session', rid: entry.r.id, email: p.email, exp: Date.now() + SESSION_MS });
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(value, isSecure(req), SESSION_MS), 'Cache-Control': 'no-store' });
      res.end();
      state.event('webui.opened', { receiver: entry.r.id, by: p.email });
      return;
    }

    if (!session(req, entry)) {
      return htmlPage(res, 401, 'Sign-in needed',
        '<p>Open the base Web UI from the NTRIP Caster extension in Trimble Connect.</p><p>If you already did and still see this inside the panel, your browser is blocking cookies for embedded pages. Use <b>Open in new tab</b> in the extension instead.</p>');
    }

    const len = Number(req.headers['content-length'] || 0);
    const chunked = /chunked/i.test(req.headers['transfer-encoding'] || '');
    if (!chunked && len <= MAX_BUFFERED_BODY) {
      // Small requests are buffered so they can be resent once if the receiver asks for its login.
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => forward(req, res, entry, Buffer.concat(chunks)));
    } else {
      forward(req, res, entry, undefined);
    }
  });

  // WebSockets (live views on some receiver firmware)
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const entry = lookup(req);
    if (!entry || !session(req, entry)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const target = new URL(entry.r.webUrl);
    const headers = upstreamHeaders(req, target, entry, req.url);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade;
    const opened = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const vv of [].concat(v)) lines.push(`${k}: ${vv}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    const upstream = target.protocol === 'https:'
      ? tls.connect({ host: target.hostname, port: portOf(target), servername: target.hostname, rejectUnauthorized: false }, opened)
      : net.connect(portOf(target), target.hostname, opened);
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  server.listen(config.webUi.port, '127.0.0.1', () => {
    console.log(`Base Web UI proxy listening on 127.0.0.1:${config.webUi.port} for *.${config.webUi.domain}`);
  });

  // Reachability: a light request every minute, so the extension can show whether the receiver answers.
  /** When a page of the receiver last loaded through the panel: proof it is reachable. */
  const lastServed = new Map(); // id -> ms

  // Some receiver web servers close the connection on bare requests, so the check asks like a browser
  // does, tries once more before reporting a failure, and a page recently loaded through the panel counts.
  const CHECK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; Connect-NTRIP reachability check)',
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    Connection: 'close',
  };
  const probe = (r, path) => new Promise(resolve => {
    const target = new URL(r.webUrl);
    const req = client(target).request({
      host: target.hostname, port: portOf(target), method: 'GET', path, timeout: 8000, rejectUnauthorized: false,
      agent: false, headers: { ...CHECK_HEADERS, Host: target.host },
    }, res => { res.resume(); resolve({ reachable: true, httpStatus: res.statusCode }); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', err => resolve({ reachable: false, error: err.code || err.message }));
    req.end();
  });
  const checkOne = async r => {
    if (!r.webUrl) return;
    let result = await probe(r, '/');
    if (!result.reachable) result = await probe(r, '/');
    // The connection worked moments ago through the panel: treat a one-off failure of the check as noise
    if (!result.reachable && Date.now() - (lastServed.get(r.id) || 0) < 5 * 60_000) result = { reachable: true, httpStatus: 200 };
    state.setReceiverStatus(r.id, result);
  };
  const check = () => config.receivers.forEach(checkOne);
  check();
  setInterval(check, 60_000).unref();
  // A receiver added or changed in the extension is checked straight away
  receiverStore?.on('change', () => {
    for (const id of [...auths.keys()]) if (!config.receivers.some(r => r.id === id)) auths.delete(id);
    check();
  });

  return server;
}

/** For Caddy's on-demand TLS: only issue certificates for configured receiver hosts. */
export function isReceiverHost(config, host) {
  host = String(host || '').toLowerCase();
  return config.receivers.some(r => r.webUrl && receiverHost(config, r) === host);
}
