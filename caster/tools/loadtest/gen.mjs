// Load generator: bases sending RTCM 3 MSM4 at 1 Hz, rovers logging in, sending GGA at 1 Hz and timing corrections.
import net from 'node:net';
import fs from 'node:fs';
const [planFile, from, to, rampMs = '20000', port = '32101'] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')).slice(Number(from), Number(to));
const PORT = Number(port);
function crc24q(b) { let c = 0; for (const x of b) { c ^= x << 16; for (let i = 0; i < 8; i++) { c <<= 1; if (c & 0x1000000) c ^= 0x1864cfb; } } return c & 0xffffff; }
function frame(msg, len, stamp) {
  const pl = Buffer.alloc(len); pl[0] = msg >> 4; pl[1] = (msg & 15) << 4;
  if (stamp) pl.writeDoubleBE(Date.now(), 4);
  const f = Buffer.concat([Buffer.from([0xd3, (len >> 8) & 3, len & 255]), pl]);
  const c = crc24q(f); return Buffer.concat([f, Buffer.from([c >> 16, (c >> 8) & 255, c & 255])]);
}
const cs = s => { let c = 0; for (const ch of s) c ^= ch.charCodeAt(0); return c.toString(16).toUpperCase().padStart(2, '0'); };
function gga(lat, lon) {
  const d = new Date(); const hh = d.toISOString().slice(11, 19).replace(/:/g, '') + '.00';
  const f = (v, w) => { const a = Math.abs(v), deg = Math.floor(a), min = (a - deg) * 60; return String(deg).padStart(w, '0') + min.toFixed(6).padStart(9, '0'); };
  const body = `GPGGA,${hh},${f(lat, 2)},${lat < 0 ? 'S' : 'N'},${f(lon, 3)},${lon < 0 ? 'W' : 'E'},4,14,0.7,350.0,M,4.0,M,1.0,0000`;
  return `$${body}*${cs(body)}\r\n`;
}
const st = { basesUp: 0, roversUp: 0, connects: 0, refused: 0, closes: 0, bytes: 0, lat: [], firstOk: null, allUpAt: null };
const total = plan.length * 200;
const t0 = Date.now();

function startBase(p, idx) {
  const lat0 = -37.2 - idx * 0.01, lon0 = 144.4 + idx * 0.01;
  p.lat0 = lat0; p.lon0 = lon0;
  const s = net.connect(PORT, '127.0.0.1', () => s.write(`SOURCE ${p.pw} /${p.mount}\r\nSource-Agent: NTRIP Trimble/load\r\n\r\n`));
  let timer, n = 0;
  s.once('data', d => {
    if (!/OK/.test(String(d))) { console.error('base refused', p.mount, String(d).trim()); return; }
    st.basesUp++;
    timer = setInterval(() => {
      const parts = [frame(1074, 300, true), frame(1084, 250), frame(1124, 250), frame(1230, 8)];
      if (n++ % 10 === 0) parts.push(frame(1005, 19));
      s.write(Buffer.concat(parts));
    }, 1000);
  });
  s.on('close', () => { clearInterval(timer); st.basesUp--; setTimeout(() => startBase(p, idx), 2000); });
  s.on('error', () => {});
}

function startRover(p, n) {
  const user = `${p.prefix}${String(n).padStart(3, '0')}`;
  const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET /${p.mount} HTTP/1.0\r\nUser-Agent: NTRIP Load/1.0\r\nAuthorization: Basic ${Buffer.from(`${user}:pw123456`).toString('base64')}\r\n\r\n`));
  let ok = false, buf = Buffer.alloc(0), timer, a = Math.random() * Math.PI * 2;
  s.on('data', d => {
    if (!ok) {
      const txt = String(d);
      if (!/^ICY 200|^HTTP\/1\.[01] 200/.test(txt)) { st.refused++; s.destroy(); return; }
      ok = true; st.roversUp++; st.connects++;
      if (st.roversUp === total && !st.allUpAt) st.allUpAt = Date.now() - t0;
      timer = setInterval(() => { a += 0.02; s.write(gga(p.lat0 + Math.sin(a) * 0.0005, p.lon0 + Math.cos(a) * 0.0006)); }, 1000);
      const i = txt.indexOf('\r\n\r\n'); d = i >= 0 ? d.subarray(i + 4) : Buffer.alloc(0);
    }
    st.bytes += d.length;
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    let i = 0;
    while (i + 6 <= buf.length) {
      if (buf[i] !== 0xd3) { i++; continue; }
      const len = ((buf[i + 1] & 3) << 8) | buf[i + 2];
      if (i + len + 6 > buf.length) break;
      const msg = (buf[i + 3] << 4) | (buf[i + 4] >> 4);
      if (msg === 1074) st.lat.push(Date.now() - buf.readDoubleBE(i + 7));
      i += len + 6;
    }
    buf = buf.subarray(i);
  });
  s.on('close', () => { clearInterval(timer); if (ok) st.roversUp--; st.closes++; setTimeout(() => startRover(p, n), 1000 + Math.random() * 4000); });
  s.on('error', () => {});
}

plan.forEach((p, idx) => startBase(p, Number(from) + idx));
setTimeout(() => {
  const all = []; plan.forEach(p => { for (let n = 0; n < 200; n++) all.push([p, n]); });
  const gap = Number(rampMs) / all.length;
  all.forEach(([p, n], k) => setTimeout(() => startRover(p, n), k * gap));
}, 1500);

setInterval(() => {
  const l = st.lat.sort((x, y) => x - y); const q = f => l.length ? l[Math.min(l.length - 1, Math.floor(l.length * f))] : null;
  console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), bases: st.basesUp, rovers: st.roversUp, of: total, refused: st.refused, closes: st.closes, allUpAtS: st.allUpAt && st.allUpAt / 1000, kBps: Math.round(st.bytes / 5 / 1024), latP50: q(0.5), latP95: q(0.95), latMax: l.length ? l[l.length - 1] : null }));
  st.lat = []; st.bytes = 0;
}, 5000);
