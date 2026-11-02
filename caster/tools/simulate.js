// Simulates a base and a few moving rovers against a caster, for testing the map.
//
//   node tools/simulate.js --host localhost --port 2101 \
//     --mount UPG_RTCM3 --source-password change-me-rtcm \
//     --rovers SIM001:secret1,SIM002:secret2 [--v2] [--lat -37.8136 --lon 144.9631]
//
// The base sends RTCM 1005 (station position) plus dummy MSM-sized frames every second.
// Each rover drives a loop around the base and sends GGA every second, alternating fix types.
import net from 'node:net';
import { crc24q } from '../src/rtcm.js';
import { encodeChunk } from '../src/chunked.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const host = args.host || 'localhost';
const port = Number(args.port || 2101);
const mount = args.mount || 'UPG_RTCM3';
const v2 = !!args.v2;
const baseLat = Number(args.lat ?? -37.8136);
const baseLon = Number(args.lon ?? 144.9631);
const rovers = String(args.rovers || '').split(',').filter(Boolean).map(s => s.split(':'));
// --cmr 93|94|98 sends Trimble CMR-framed data (CMR+/CMRx) instead of RTCM
const cmrType = args.cmr ? parseInt(String(args.cmr), 16) : null;
const user = args.user || 'base';

// ---------------------------------------------------------------- RTCM helpers
class BitWriter {
  constructor(bytes) { this.buf = Buffer.alloc(bytes); this.pos = 0; }
  put(value, len) {
    let v = value < 0 ? 2 ** len + value : value;
    for (let i = len - 1; i >= 0; i--) {
      const bit = Math.floor(v / 2 ** i) % 2;
      if (bit) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
}

function frame(payload) {
  const f = Buffer.alloc(payload.length + 6);
  f[0] = 0xd3;
  f[1] = (payload.length >> 8) & 0x03;
  f[2] = payload.length & 0xff;
  payload.copy(f, 3);
  f.writeUIntBE(crc24q(f, 0, payload.length + 3), payload.length + 3, 3);
  return f;
}

function llaToEcef(latDeg, lonDeg, h) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return {
    x: (N + h) * Math.cos(lat) * Math.cos(lon),
    y: (N + h) * Math.cos(lat) * Math.sin(lon),
    z: (N * (1 - e2) + h) * Math.sin(lat),
  };
}

function msg1005(lat, lon, h) {
  const { x, y, z } = llaToEcef(lat, lon, h);
  const w = new BitWriter(19);
  w.put(1005, 12); w.put(42, 12); w.put(0, 6); w.put(1, 1); w.put(1, 1); w.put(1, 1); w.put(0, 1);
  w.put(Math.round(x / 0.0001), 38); w.put(0, 1); w.put(0, 1);
  w.put(Math.round(y / 0.0001), 38); w.put(0, 2);
  w.put(Math.round(z / 0.0001), 38);
  return frame(w.buf);
}

function cmrFrame(type) {
  const len = 60;
  const f = Buffer.alloc(len + 6);
  f[0] = 0x02; f[1] = 0x00; f[2] = type; f[3] = len;
  for (let i = 0; i < len; i++) f[4 + i] = (Math.random() * 256) | 0;
  let sum = 0;
  for (let i = 1; i < 4 + len; i++) sum = (sum + f[i]) & 0xff;
  f[4 + len] = sum; f[5 + len] = 0x03;
  return f;
}

function dummyMsm(type) {
  const p = Buffer.alloc(120);
  for (let i = 0; i < p.length; i++) p[i] = (Math.random() * 256) | 0;
  p[0] = type >> 4; p[1] = ((type & 0x0f) << 4) | (p[1] & 0x0f);
  return frame(p);
}

// ---------------------------------------------------------------- NMEA helpers
function nmeaCoord(v, isLat) {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  const ds = String(d).padStart(isLat ? 2 : 3, '0');
  return `${ds}${m.toFixed(6).padStart(9, '0')},${isLat ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E')}`;
}

function gga(lat, lon, quality, sats) {
  const t = new Date();
  const hhmmss = `${String(t.getUTCHours()).padStart(2, '0')}${String(t.getUTCMinutes()).padStart(2, '0')}${String(t.getUTCSeconds()).padStart(2, '0')}.00`;
  const body = `GPGGA,${hhmmss},${nmeaCoord(lat, true)},${nmeaCoord(lon, false)},${quality},${sats},0.8,45.123,M,4.5,M,1.0,0042`;
  let cs = 0;
  for (const ch of body) cs ^= ch.charCodeAt(0);
  return `$${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}

// ---------------------------------------------------------------- base
function startBase() {
  const sock = net.connect(port, host, () => {
    if (v2) {
      const auth = Buffer.from(`${user}:${args['source-password']}`).toString('base64');
      sock.write(`POST /${mount} HTTP/1.1\r\nHost: ${host}\r\nNtrip-Version: Ntrip/2.0\r\nAuthorization: Basic ${auth}\r\nUser-Agent: NTRIP SimBase/1.0\r\nTransfer-Encoding: chunked\r\n\r\n`);
    } else {
      sock.write(`SOURCE ${args['source-password']} /${mount}\r\nSource-Agent: NTRIP SimBase/1.0\r\n\r\n`);
    }
  });
  let n = 0;
  sock.once('data', d => {
    console.log(`base: ${d.toString().split('\r\n')[0]}`);
    const timer = setInterval(() => {
      const parts = cmrType ? [cmrFrame(cmrType), cmrFrame(cmrType)] : [dummyMsm(1077), dummyMsm(1087), dummyMsm(1097)];
      if (!cmrType && n++ % 5 === 0) parts.unshift(msg1005(baseLat, baseLon, 50));
      const data = Buffer.concat(parts);
      sock.write(v2 ? encodeChunk(data) : data);
    }, 1000);
    sock.on('close', () => { clearInterval(timer); console.log('base: closed'); });
  });
  sock.on('error', e => console.log('base error', e.message));
}

// ---------------------------------------------------------------- rovers
function startRover([serial, password], idx) {
  const sock = net.connect(port, host, () => {
    const auth = Buffer.from(`${serial}:${password}`).toString('base64');
    const hdr = v2
      ? `GET /${mount} HTTP/1.1\r\nHost: ${host}\r\nNtrip-Version: Ntrip/2.0\r\nUser-Agent: NTRIP SimRover/1.0\r\nAuthorization: Basic ${auth}\r\n\r\n`
      : `GET /${mount} HTTP/1.0\r\nUser-Agent: NTRIP SimRover/1.0\r\nAuthorization: Basic ${auth}\r\n\r\n`;
    sock.write(hdr);
  });
  let bytes = 0, first = true, t = idx * 40;
  sock.on('data', d => {
    if (first) { console.log(`${serial}: ${d.toString('latin1').split('\r\n')[0]}`); first = false; }
    bytes += d.length;
  });
  const radius = 0.0015 + idx * 0.0007; // ~150-300 m loops
  const timer = setInterval(() => {
    t++;
    const ang = (t / 60) * 2 * Math.PI;
    const lat = baseLat + radius * Math.sin(ang);
    const lon = baseLon + (radius * Math.cos(ang)) / Math.cos((baseLat * Math.PI) / 180);
    const quality = t % 40 < 30 ? 4 : 5;
    const sentence = gga(lat, lon, quality, 18 - idx);
    sock.write(v2 ? encodeChunk(Buffer.from(sentence)) : sentence);
  }, 1000);
  setInterval(() => console.log(`${serial}: received ${bytes} bytes`), 10_000).unref();
  sock.on('close', () => { clearInterval(timer); console.log(`${serial}: closed`); });
  sock.on('error', e => console.log(`${serial} error`, e.message));
}

if (args['source-password']) startBase();
setTimeout(() => rovers.forEach(startRover), 500);
