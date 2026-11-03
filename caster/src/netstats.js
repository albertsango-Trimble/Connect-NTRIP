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

export function startNetStats({ config, state }) {
  let busy = false;
  let warned = false;
  const tick = () => {
    if (busy || !state.clients.size) return;
    busy = true;
    execFile('ss', ['-tinH', 'state', 'established', `( sport = :${config.ntripPort} )`], { maxBuffer: 256 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      busy = false;
      if (err) {
        if (!warned) console.warn(`Connection quality not available (could not run ss: ${err.code || err.message})`);
        warned = true;
        return;
      }
      const stats = parseSs(stdout);
      const now = Date.now();
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
        c.net = {
          pingMs: s.rttMs != null ? Math.round(s.rttMs) : null,
          jitterMs: s.rttVarMs != null ? Math.round(s.rttVarMs) : null,
          lossPct: loss == null ? null : Math.round(loss * 10) / 10,
          sendQueue: s.sendQ,
          at: now,
          ...grade({ rttMs: s.rttMs, lossPct: loss, stalled, sendQ: s.sendQ, ageOfCorrections: age }),
        };
      }
    });
  };
  const timer = setInterval(tick, EVERY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
