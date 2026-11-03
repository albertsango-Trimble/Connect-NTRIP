// Connection quality of each rover, from the network path the caster sees (NTRIP has no way for a receiver to
// report its own signal strength). Every few seconds the kernel's TCP statistics are read with `ss`:
//   ping     smoothed round-trip time to the machine, and how much it varies
//   resent   share of data packets that had to be sent again (lost on the way)
//   stalled  the machine has stopped acknowledging data
// together with how old the machine says its corrections are (from its GGA). Linux only; elsewhere the
// figures are simply left out.
import { execFile } from 'node:child_process';

const EVERY_MS = 5000;
const norm = a => String(a || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
/** "[::ffff:1.2.3.4]:5678" or "1.2.3.4:5678" -> "1.2.3.4:5678" */
function peerKey(s) {
  const m = String(s).match(/^\[?(.*?)\]?:(\d+)$/);
  return m ? `${norm(m[1])}:${m[2]}` : s;
}

/** Parses `ss -tinH` output into Map(peer "ip:port" -> stats). */
export function parseSs(text) {
  const out = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const [recvQ, sendQ, , peer] = line.trim().split(/\s+/);
      cur = { sendQ: Number(sendQ) || 0, recvQ: Number(recvQ) || 0 };
      out.set(peerKey(peer), cur);
      continue;
    }
    if (!cur) continue;
    const num = k => { const m = line.match(new RegExp(`(?:^|\\s)${k}:([\\d.]+)`)); return m ? Number(m[1]) : undefined; };
    const rtt = line.match(/\srtt:([\d.]+)\/([\d.]+)/);
    if (rtt) { cur.rttMs = Number(rtt[1]); cur.rttVarMs = Number(rtt[2]); }
    // Round trip estimated from the data a peer sends us (a base mostly sends, so its rtt alone can be stale)
    const rcv = line.match(/\srcv_rtt:([\d.]+)/);
    if (rcv) cur.rcvRttMs = Number(rcv[1]);
    const re = line.match(/\sretrans:\d+\/(\d+)/);
    cur.retrans = re ? Number(re[1]) : 0;
    cur.segsOut = num('data_segs_out') ?? num('segs_out') ?? 0;
    cur.lastAckMs = num('lastack');
    cur.unacked = num('unacked') ?? 0;
  }
  return out;
}

/** 4 bars = Excellent ... 1 bar = Poor, with the reasons for anything less than excellent. */
export function grade({ rttMs, lossPct, stalled, sendQ, ageOfCorrections }) {
  let bars = 4;
  const why = [];
  const cap = (b, reason) => { if (b < bars) bars = b; why.push(reason); };
  if (rttMs != null) {
    if (rttMs > 1000) cap(1, `very slow link (${Math.round(rttMs)} ms ping)`);
    else if (rttMs > 400) cap(2, `slow link (${Math.round(rttMs)} ms ping)`);
    else if (rttMs > 150) cap(3, `${Math.round(rttMs)} ms ping`);
  }
  if (lossPct != null) {
    if (lossPct > 8) cap(1, `${lossPct.toFixed(1)}% of data resent`);
    else if (lossPct > 2) cap(2, `${lossPct.toFixed(1)}% of data resent`);
    else if (lossPct > 0.5) cap(3, `${lossPct.toFixed(1)}% of data resent`);
  }
  if (stalled) cap(1, 'not acknowledging data');
  else if (sendQ > 64 * 1024) cap(1, 'corrections backing up (machine not keeping up)');
  else if (sendQ > 16 * 1024) cap(2, 'corrections backing up');
  if (ageOfCorrections != null) {
    if (ageOfCorrections > 10) cap(1, `corrections ${ageOfCorrections} s old`);
    else if (ageOfCorrections > 3) cap(2, `corrections ${ageOfCorrections} s old`);
  }
  return { bars, label: ['', 'Poor', 'Fair', 'Good', 'Excellent'][bars], reasons: why };
}

/** Grade for a base's connection: how late its epochs arrive, epochs missed, gaps and corrupt data. */
export function gradeBase({ latencyMs, missedPct, gapMs, crcPct, pingMs }) {
  let bars = 4;
  const why = [];
  const cap = (b, reason) => { if (b < bars) bars = b; why.push(reason); };
  if (gapMs > 5000) cap(1, `no data for ${Math.round(gapMs / 1000)} s`);
  else if (gapMs > 2500) cap(2, `data stalling (${(gapMs / 1000).toFixed(1)} s gap)`);
  if (latencyMs != null) {
    if (latencyMs > 2000) cap(1, `corrections arriving ${(latencyMs / 1000).toFixed(1)} s late`);
    else if (latencyMs > 1000) cap(2, `corrections arriving ${(latencyMs / 1000).toFixed(1)} s late`);
    else if (latencyMs > 500) cap(3, `${latencyMs} ms latency`);
  }
  if (missedPct != null) {
    if (missedPct > 15) cap(1, `${missedPct.toFixed(1)}% of epochs missing`);
    else if (missedPct > 5) cap(2, `${missedPct.toFixed(1)}% of epochs missing`);
    else if (missedPct > 1) cap(3, `${missedPct.toFixed(1)}% of epochs missing`);
  }
  if (crcPct != null && crcPct > 0.5) cap(2, `${crcPct.toFixed(1)}% of data corrupted`);
  if (pingMs != null) {
    if (pingMs > 1000) cap(2, `slow link (${Math.round(pingMs)} ms ping)`);
    else if (pingMs > 400) cap(3, `${Math.round(pingMs)} ms ping`);
  }
  return { bars, label: ['', 'Poor', 'Fair', 'Good', 'Excellent'][bars], reasons: why };
}

function updateBase(src, s, now) {
  const r = src.monitor?.rtcm;
  const lat = r?.latencyStats?.() || null;
  // Epochs missed and corrupt frames since the last look, smoothed over about half a minute
  const prev = src.baseRaw;
  const cur = { epochs: r?.epochs || 0, missed: r?.missed || 0, crc: r?.crcErrors || 0, frames: r?.frames || 0 };
  src.baseRaw = cur;
  let missedPct = src.net?.missedPct ?? null;
  let crcPct = src.net?.crcPct ?? null;
  if (prev) {
    const exp = (cur.epochs - prev.epochs) + (cur.missed - prev.missed);
    if (exp > 0) { const v = ((cur.missed - prev.missed) / exp) * 100; missedPct = missedPct == null ? v : missedPct * 0.8 + v * 0.2; }
    const fr = (cur.frames - prev.frames) + (cur.crc - prev.crc);
    if (fr > 0) { const v = ((cur.crc - prev.crc) / fr) * 100; crcPct = crcPct == null ? v : crcPct * 0.8 + v * 0.2; }
  }
  const pingMs = s ? (s.rcvRttMs ?? s.rttMs ?? null) : null;
  const gapMs = src.lastDataAt ? now - src.lastDataAt : now - src.connectedAt;
  const graded = gradeBase({ latencyMs: lat?.avgMs ?? null, missedPct, gapMs, crcPct, pingMs });
  const acc = (src.netAcc ??= { n: 0, latSum: 0, latMax: 0, pingSum: 0, pingN: 0, gradeSec: { excellent: 0, good: 0, fair: 0, poor: 0 } });
  if (lat) { acc.n++; acc.latSum += lat.avgMs; acc.latMax = Math.max(acc.latMax, lat.maxMs); }
  if (pingMs != null) { acc.pingN++; acc.pingSum += pingMs; }
  acc.gradeSec[['', 'poor', 'fair', 'good', 'excellent'][graded.bars]] += EVERY_MS / 1000;
  src.net = {
    latencyMs: lat?.avgMs ?? null,
    latencyMaxMs: lat?.maxMs ?? null,
    pingMs: pingMs != null ? Math.round(pingMs) : null,
    missedPct: missedPct == null ? null : Math.round(missedPct * 10) / 10,
    crcPct: crcPct == null ? null : Math.round(crcPct * 10) / 10,
    rateHz: r?.interval ? Math.round((1000 / r.interval) * 10) / 10 : null,
    at: now,
    ...graded,
  };
}

export function startNetStats({ config, state }) {
  let busy = false;
  let warned = false;
  const tick = () => {
    if (busy || (!state.clients.size && !state.sources.size)) return;
    busy = true;
    execFile('ss', ['-tinH', 'state', 'established', `( sport = :${config.ntripPort} )`], { maxBuffer: 256 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      busy = false;
      const now = Date.now();
      if (err) {
        if (!warned) console.warn(`Network figures not available (could not run ss: ${err.code || err.message}); base latency still measured from the data`);
        warned = true;
        for (const src of state.sources.values()) updateBase(src, null, now);
        return;
      }
      const stats = parseSs(stdout);
      for (const src of state.sources.values()) updateBase(src, stats.get(peerKey(src.addr)) || null, now);
      for (const c of state.clients.values()) {
        const s = stats.get(peerKey(c.addr));
        if (!s) continue;
        const prev = c.netRaw;
        c.netRaw = { retrans: s.retrans, segsOut: s.segsOut };
        // Share of packets resent over the last interval, smoothed over about half a minute
        let loss = c.net?.lossPct ?? null;
        if (prev && s.segsOut > prev.segsOut) {
          const pct = (Math.max(0, s.retrans - prev.retrans) / (s.segsOut - prev.segsOut)) * 100;
          loss = loss == null ? pct : loss * 0.8 + pct * 0.2;
        }
        const stalled = s.unacked > 0 && (s.lastAckMs ?? 0) > 5000;
        const age = c.gga?.ageOfCorrections ?? null;
        const graded = grade({ rttMs: s.rttMs, lossPct: loss, stalled, sendQ: s.sendQ, ageOfCorrections: age });
        // Totals over the session for its history record and the monthly report
        const acc = (c.netAcc ??= { n: 0, pingSum: 0, pingMax: 0, gradeSec: { excellent: 0, good: 0, fair: 0, poor: 0 } });
        if (s.rttMs != null) { acc.n++; acc.pingSum += s.rttMs; acc.pingMax = Math.max(acc.pingMax, Math.round(s.rttMs)); }
        acc.gradeSec[['', 'poor', 'fair', 'good', 'excellent'][graded.bars]] += EVERY_MS / 1000;
        c.net = {
          pingMs: s.rttMs != null ? Math.round(s.rttMs) : null,
          jitterMs: s.rttVarMs != null ? Math.round(s.rttVarMs) : null,
          lossPct: loss == null ? null : Math.round(loss * 10) / 10,
          sendQueue: s.sendQ,
          at: now,
          ...graded,
        };
      }
    });
  };
  const timer = setInterval(tick, EVERY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
