// NTRIP caster TCP server. Handles both NTRIP 1.0 and 2.0 on the same port:
//   base (source):  v1 "SOURCE <pw> /<mount>"      v2 "POST /<mount> HTTP/1.1" + Ntrip-Version: Ntrip/2.0
//   rover (client): v1 "GET /<mount> HTTP/1.0"     v2 "GET /<mount> HTTP/1.1"  + Ntrip-Version: Ntrip/2.0
//   sourcetable:    "GET / ..." in either version
// Corrections (RTCM, CMRx, CMR+) are relayed byte-for-byte; the caster never rewrites them.
import net from 'node:net';
import { findMountpoint } from './config.js';
import { normaliseSerial } from './devices.js';
import { GgaScanner, parseGga } from './nmea.js';
import { FormatMonitor } from './format.js';
import { ChunkDecoder, encodeChunk } from './chunked.js';

const MAX_HEADER = 8192;
const MAX_CLIENT_BUFFER = 512 * 1024; // drop rovers that can't keep up
const SERVER = 'Connect-NTRIP/0.1';

export function startNtripServer({ config, state }) {
  const server = net.createServer(sock => acceptConnection(sock, { config, state }));
  server.on('error', err => console.error('NTRIP server error', err));
  server.listen(config.ntripPort, () => console.log(`NTRIP caster listening on :${config.ntripPort}`));
  return server;
}

function acceptConnection(sock, ctx) {
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 30_000);
  sock.on('error', () => {});
  const addr = `${sock.remoteAddress?.replace(/^::ffff:/, '')}:${sock.remotePort}`;
  let buf = Buffer.alloc(0);
  let gotRequest = false;
  const preview = b => JSON.stringify(b.subarray(0, 120).toString('latin1'));
  const headerTimer = setTimeout(() => {
    console.log(`connection from ${addr} sent no complete request within 15 s (${buf.length} bytes: ${preview(buf)})`);
    sock.destroy();
  }, 15_000);
  // A client that disconnects before sending a full request is logged too, with what it did send
  sock.on('close', () => {
    clearTimeout(headerTimer);
    if (!gotRequest) console.log(`connection from ${addr} closed before a complete request (${buf.length} bytes: ${preview(buf)})`);
  });

  const onData = chunk => {
    buf = Buffer.concat([buf, chunk]);
    let idx = buf.indexOf('\r\n\r\n');
    let sep = 4;
    if (idx < 0) {
      const alt = buf.indexOf('\n\n');
      if (alt >= 0) { idx = alt; sep = 2; }
    }
    if (idx < 0) {
      if (buf.length > MAX_HEADER) sock.destroy();
      return;
    }
    clearTimeout(headerTimer);
    gotRequest = true;
    sock.off('data', onData);
    sock.pause();
    const req = parseRequest(buf.subarray(0, idx).toString('latin1'));
    req.addr = addr;
    if (req.method !== 'SOURCE' && req.method !== 'POST') {
      // Rover and sourcetable requests: first line and client name, never the password
      console.log(`request from ${addr}: ${JSON.stringify(buf.subarray(0, idx).toString('latin1').split(/\r?\n/)[0].slice(0, 120))} (${req.headers['user-agent'] || 'no user agent'})`);
    }
    const rest = buf.subarray(idx + sep);
    try {
      route(sock, req, rest, ctx);
    } catch (err) {
      console.error('request error', err);
      sock.destroy();
    }
  };
  sock.on('data', onData);
}

function parseRequest(head) {
  const lines = head.split(/\r?\n/);
  const [method = '', a = '', b = ''] = lines[0].trim().split(/\s+/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const v2 = /ntrip\/2/i.test(headers['ntrip-version'] || '');
  return { method: method.toUpperCase(), a, b, headers, v2 };
}

function mountFromPath(p) {
  return decodeURIComponent(String(p || '').replace(/^\//, '').split('?')[0]);
}

function basicAuth(headers) {
  const h = headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

function route(sock, req, rest, ctx) {
  if (req.method === 'SOURCE') return handleSourceV1(sock, req, rest, ctx);
  if (req.method === 'POST') return handleSourceV2(sock, req, rest, ctx);
  if (req.method === 'GET') {
    const mount = mountFromPath(req.a);
    if (!mount) {
      console.log(`sourcetable request from ${req.addr} (${req.headers['user-agent'] || 'no user agent'}, ${req.v2 ? 'NTRIP 2' : 'NTRIP 1'})`);
      return sendSourcetable(sock, req, ctx);
    }
    return handleClient(sock, req, mount, rest, ctx);
  }
  console.log(`unrecognised request from ${req.addr}: ${JSON.stringify(req.method + ' ' + req.a + ' ' + req.b).slice(0, 120)}`);
  sock.end(req.v2 ? httpStatus(405, 'Method Not Allowed') : 'HTTP/1.0 400 Bad Request\r\n\r\n');
}

function httpStatus(code, text, extra = '') {
  return `HTTP/1.1 ${code} ${text}\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nDate: ${new Date().toUTCString()}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`;
}

// ---------------------------------------------------------------- sourcetable
/** Sourcetable fields are plain ASCII separated by ';' (NTRIP 1/2). */
const ascii = v => String(v ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/;/g, ',').trim();

const MSM_NAV = [[1070, 'GPS'], [1080, 'GLO'], [1090, 'GAL'], [1100, 'SBAS'], [1110, 'QZS'], [1120, 'BDS'], [1130, 'IRS']];

/** Format, format details and navigation systems for an STR line, from what the base is actually sending. */
function streamInfo(m, state) {
  const mon = state?.sources.get(m.name)?.monitor;
  const types = mon ? mon.messageTypes() : [];
  const detected = mon?.detected?.() || null;
  const label = detected || (m.auto ? m.format : null) || m.format || '';
  let format;
  if (/^RTCM/i.test(label)) format = label.split('·')[0].trim();                 // "RTCM 3.3"
  else if (/CMRx/i.test(label)) format = 'CMRx';
  else if (/CMR\+|CMR\/CMR\+/i.test(label)) format = 'CMR+';
  else if (/CMR/i.test(label)) format = 'CMR';
  else format = m.auto ? 'unknown' : label;
  const details = types.length ? types.filter(t => t < 4000).join(',') : (m.auto ? '' : m.formatDetails || '');
  const nav = [...new Set(types.map(t => MSM_NAV.find(([b]) => t > b && t <= b + 7)?.[1]).filter(Boolean))];
  return { format, details, nav: nav.length ? nav.join('+') : (m.navSystem || 'GPS') };
}

function buildSourcetable({ config, state }) {
  const host = config.publicHost || 'localhost';
  const lines = [];
  for (const m of config.mountpoints) {
    if (m.auto && !state?.sources.has(m.name)) continue; // a base's own mountpoint is listed while it is sending
    const pos = state?.position(m) || { lat: m.lat ?? 0, lon: m.lon ?? 0 };
    const info = streamInfo(m, state);
    lines.push([
      'STR', m.name, m.identifier || m.name, info.format, info.details, m.carrier ?? 2,
      info.nav, m.network || config.casterName || 'Connect-NTRIP', m.country || config.country || '',
      Number(pos.lat).toFixed(2), Number(pos.lon).toFixed(2), 0, 0, m.generator || 'Trimble', 'none', 'B', 'N',
      m.bitrate || 9600, m.misc || '',
    ].map((v, i) => (i === 1 ? v : ascii(v))).join(';'));
  }
  lines.push(['CAS', host, config.ntripPort, config.casterName || 'Connect-NTRIP', config.operator || '', 0,
    config.country || '', '0.00', '0.00', '0.0.0.0', 0, ''].map(ascii).join(';'));
  return lines.join('\r\n') + '\r\nENDSOURCETABLE\r\n';
}

function sendSourcetable(sock, req, ctx) {
  const body = buildSourcetable(ctx);
  const len = Buffer.byteLength(body);
  if (req.v2) {
    sock.end(`HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nDate: ${new Date().toUTCString()}\r\nConnection: close\r\nContent-Type: gnss/sourcetable\r\nContent-Length: ${len}\r\n\r\n${body}`);
  } else {
    sock.end(`SOURCETABLE 200 OK\r\nServer: ${SERVER}\r\nContent-Type: text/plain\r\nContent-Length: ${len}\r\n\r\n${body}`);
  }
}

// ---------------------------------------------------------------- base stations
function handleSourceV1(sock, req, rest, ctx) {
  // "SOURCE <password> /<mount>"  (some firmware omits the slash)
  const mount = mountFromPath(req.b);
  const m = sourceMountpoint(ctx.config, mount, req.a, req.headers['ntrip-str']);
  if (!m) {
    const known = findMountpoint(ctx.config, mount);
    ctx.state.event('source.rejected', { project: known ? ctx.config.projects.projectOf(known) : undefined, mount, addr: req.addr, reason: rejectReason(ctx.config, known) });
    sock.end('ERROR - Bad Password\r\n');
    return;
  }
  sock.write('ICY 200 OK\r\n\r\n');
  attachSource(sock, req, m, 'NTRIP 1.0', rest, null, ctx);
}

function handleSourceV2(sock, req, rest, ctx) {
  const mount = mountFromPath(req.a);
  const auth = basicAuth(req.headers);
  const m = sourceMountpoint(ctx.config, mount, auth?.pass, req.headers['ntrip-str']);
  if (!m) {
    const known = findMountpoint(ctx.config, mount);
    if (!known && !ctx.config.autoMounts.enabled) {
      ctx.state.event('source.rejected', { mount, addr: req.addr, reason: 'unknown mountpoint' });
      sock.end(httpStatus(404, 'Not Found'));
      return;
    }
    ctx.state.event('source.rejected', { project: known ? ctx.config.projects.projectOf(known) : undefined, mount, addr: req.addr, reason: rejectReason(ctx.config, known) });
    sock.end(httpStatus(401, 'Unauthorized', `WWW-Authenticate: Basic realm="/${mount}"\r\n`));
    return;
  }
  sock.write(`HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nDate: ${new Date().toUTCString()}\r\nConnection: close\r\n\r\n`);
  const chunked = /chunked/i.test(req.headers['transfer-encoding'] || '');
  attachSource(sock, req, m, 'NTRIP 2.0', rest, chunked ? new ChunkDecoder() : null, ctx);
}

/** The mountpoint a base may send to: a configured one with its own password, or one it names itself with the shared password. */
function sourceMountpoint(config, name, password, strHeader) {
  const m = findMountpoint(config, name);
  if (m && !m.auto) return password === m.sourcePassword ? m : null;
  return config.autoMounts.claim(name, password, strHeader);
}

function rejectReason(config, known) {
  if (known && !known.auto) return 'bad password';
  return config.autoMounts.enabled ? 'bad password' : 'unknown mountpoint';
}

function attachSource(sock, req, m, protocol, rest, decoder, { config, state }) {
  const src = {
    mount: m.name,
    format: m.format,
    addr: req.addr,
    protocol,
    agent: req.headers['source-agent'] || req.headers['user-agent'] || '',
    monitor: new FormatMonitor(),
    project: config.projects.projectOf(m),
    close: () => sock.destroy(),
  };
  state.addSource(src);

  const onData = chunk => {
    let data = chunk;
    if (decoder) {
      try { data = decoder.push(chunk); } catch { sock.destroy(); return; }
      if (decoder.done) sock.end();
    }
    if (data.length) state.relay(src, data);
  };
  sock.setTimeout(config.sourceIdleTimeoutSec * 1000, () => {
    state.event('source.timeout', { mount: m.name, addr: req.addr });
    sock.destroy();
  });
  sock.on('data', onData);
  sock.on('close', () => {
    if (m.auto) config.autoMounts.update(m, { format: src.monitor.detected(), station: src.monitor.station, fallback: state.sitePosition(src) });
    state.removeSource(src, 'closed');
  });
  if (rest.length) onData(rest);
  sock.resume();
}

// ---------------------------------------------------------------- rovers
function handleClient(sock, req, mount, rest, { config, state }) {
  const m = findMountpoint(config, mount);
  if (!m) {
    // NTRIP 1 convention: unknown mountpoint gets the sourcetable
    if (req.v2) sock.end(httpStatus(404, 'Not Found'));
    else sendSourcetable(sock, req, { config, state });
    return;
  }

  // Rovers sign in with the logins of the project the mountpoint belongs to
  const project = config.projects.projectOf(m);
  const devices = config.projects.devicesFor(project);
  const auth = basicAuth(req.headers);
  const serial = normaliseSerial(auth?.user);
  const result = auth ? devices.authenticate(serial, auth.pass, mount) : { ok: false, reason: 'no credentials' };
  if (!result.ok) {
    state.event('rover.rejected', { project, serial: serial || '(none)', mount, addr: req.addr, reason: result.reason });
    if (serial && devices.get(serial)) state.recordRejected(project, serial, { mount, addr: req.addr, reason: result.reason, agent: req.headers['user-agent'] || '' });
    const realm = `WWW-Authenticate: Basic realm="/${mount}"\r\n`;
    sock.end(req.v2 ? httpStatus(401, 'Unauthorized', realm) : `HTTP/1.0 401 Unauthorized\r\n${realm}\r\n`);
    return;
  }

  if (req.v2) {
    sock.write(`HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nServer: ${SERVER}\r\nDate: ${new Date().toUTCString()}\r\nCache-Control: no-store, no-cache, max-age=0\r\nPragma: no-cache\r\nConnection: close\r\nContent-Type: gnss/data\r\nTransfer-Encoding: chunked\r\n\r\n`);
  } else {
    sock.write('ICY 200 OK\r\n\r\n');
  }

  const client = {
    id: state.newId(),
    project,
    serial,
    label: result.device.label,
    mount,
    addr: req.addr,
    protocol: req.v2 ? 'NTRIP 2.0' : 'NTRIP 1.0',
    agent: req.headers['user-agent'] || '',
    send(data) {
      if (sock.destroyed) return;
      if (sock.writableLength > MAX_CLIENT_BUFFER) {
        state.event('rover.overflow', { project, serial, mount });
        client.endReason = 'dropped: could not keep up with the data';
        sock.destroy();
        return;
      }
      sock.write(req.v2 ? encodeChunk(data) : data);
      client.bytesOut += data.length;
    },
    close: () => sock.destroy(),
  };
  state.addClient(client);

  // Rover -> caster: NMEA GGA (raw in v1; chunked or raw in v2, plus optional Ntrip-GGA header)
  const scanner = new GgaScanner();
  const handleIncoming = chunk => {
    for (const gga of scanner.push(chunk)) state.updateGga(client, gga);
  };
  if (req.headers['ntrip-gga']) {
    const gga = parseGga(req.headers['ntrip-gga'].trim());
    if (gga) state.updateGga(client, gga);
  }
  // Dead rovers are detected by TCP keepalive (set on accept) or a failed write.
  sock.on('data', handleIncoming);
  sock.on('close', () => state.removeClient(client, 'connection closed'));
  if (rest.length) handleIncoming(rest);
  sock.resume();
}
