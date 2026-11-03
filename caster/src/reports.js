// Monthly report for each mountpoint of a project: a PDF and a CSV of every session in the month.
// Built by the caster shortly after midnight on the 1st (in config.reportTimeZone, default Australia/Sydney) and
// kept in <project>/reports/<YYYY-MM>/; the extension saves them into the Connect project the next time a project
// admin opens it, always under the same file names so Trimble Connect keeps each month as a new version.
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import proj4 from 'proj4';
import { fromUrl } from 'geotiff';
import { rtcmLabel } from './format.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REPORT_NAME = 'NTRIP Caster Monthly Report';

// ---------------------------------------------------------------- time zones and months
function tzOffsetMs(tz, utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/** UTC time of local midnight starting the given day in a time zone. */
function localMidnight(tz, y, m, d = 1) {
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) t = Date.UTC(y, m - 1, d) - tzOffsetMs(tz, t);
  return t;
}
export function monthRange(tz, month) {
  const [y, m] = month.split('-').map(Number);
  return { from: localMidnight(tz, y, m), to: localMidnight(tz, m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1) };
}
export function monthOf(tz, utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const monthTitle = (month, tz) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5) - 1, 15)));
const fmt = (tz, ms, opts) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, hourCycle: 'h23', ...opts }).format(new Date(ms));
const dateTime = (tz, ms) => fmt(tz, ms, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayKey = (tz, ms) => fmt(tz, ms, { year: 'numeric', month: '2-digit', day: '2-digit' });

// ---------------------------------------------------------------- small helpers
const hours = ms => ms / HOUR;
const h1 = ms => (ms / HOUR).toFixed(1);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const pct0 = (a, b) => `${pct(a, b).toFixed(0)}%`;
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const durText = ms => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
};
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
  }
  return out;
}
/** Merges [start, end] intervals. */
function merge(intervals) {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const MSM_SYSTEMS = [[1070, 'GPS'], [1080, 'GLONASS'], [1090, 'Galileo'], [1100, 'SBAS'], [1110, 'QZSS'], [1120, 'BeiDou'], [1130, 'NavIC']];
function systems(types) {
  const out = new Set();
  for (const t of types) { const s = MSM_SYSTEMS.find(([b]) => t > b && t <= b + 7); if (s) out.add(s[1]); }
  if (!out.size) { if (types.some(t => t >= 1001 && t <= 1004)) out.add('GPS'); if (types.some(t => t >= 1009 && t <= 1012)) out.add('GLONASS'); }
  return [...out];
}

// ---------------------------------------------------------------- project coordinates
const geoidCache = new Map();
async function geoidSeparation(file, lat, lon) {
  try {
    let open = geoidCache.get(file);
    if (!open) { open = fromUrl(`https://cdn.proj.org/${file}`); geoidCache.set(file, open); }
    const img = await (await open).getImage(0);
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const area = img.getGeoKeys()?.GTRasterTypeGeoKey !== 2;
    let fx = (lon - ox) / rx - (area ? 0.5 : 0);
    const fy = (lat - oy) / ry - (area ? 0.5 : 0);
    if (fx < 0 && ox < -170) fx += 360 / rx;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= img.getWidth() || y0 + 1 >= img.getHeight()) return null;
    const [band] = await img.readRasters({ window: [x0, y0, x0 + 2, y0 + 2], samples: [0], interleave: false });
    const v = [band[0], band[1], band[2], band[3]];
    if (v.some(x => !Number.isFinite(x) || Math.abs(x) > 500)) return null;
    const tx = fx - x0, ty = fy - y0;
    return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty;
  } catch (err) {
    console.warn(`Report: could not read geoid ${file}: ${err.message}`);
    geoidCache.delete(file);
    return null;
  }
}
/** Rows describing a position in the project's coordinate system (when known) and as latitude/longitude. */
async function positionRows(pos, geo) {
  const rows = [];
  if (geo?.proj4) {
    try {
      const [e, n] = proj4('EPSG:4326', geo.proj4, [pos.lon, pos.lat]);
      if (Number.isFinite(e) && Number.isFinite(n)) rows.push(['Easting', `${e.toFixed(3)} m`], ['Northing', `${n.toFixed(3)} m`]);
    } catch { /* leave out */ }
  }
  if (pos.h != null) {
    const sep = geo?.geoid?.file ? await geoidSeparation(geo.geoid.file, pos.lat, pos.lon) : null;
    if (sep != null) rows.push(['Elevation', `${(pos.h - sep).toFixed(3)} m ${geo.geoid.datum} (${geo.geoid.name})`]);
    rows.push(['Ellipsoidal height', `${pos.h.toFixed(3)} m`]);
  }
  rows.push(['Latitude', `${pos.lat.toFixed(8)}°`], ['Longitude', `${pos.lon.toFixed(8)}°`]);
  return rows;
}

// ---------------------------------------------------------------- gathering a month
function gather({ config, state, projects, projectId: P, mount, from, to, now }) {
  const end = Math.min(to, now);
  const span = end - from;
  // Base connections (finished ones from the file, plus one still connected)
  const baseRecs = projects.readBase(P, mount).filter(r => r.end > from && r.start < end);
  const live = state.sources.get(mount);
  if (live) {
    const a = live.netAcc;
    baseRecs.push({ start: live.connectedAt, end: now, bytes: live.bytesIn, format: live.monitor?.detected?.() || null, messageTypes: live.monitor?.messageTypes() || [], addr: live.addr, live: true,
      net: a ? { avgLatencyMs: a.n ? Math.round(a.latSum / a.n) : null, maxLatencyMs: a.n ? a.latMax : null, avgPingMs: a.pingN ? Math.round(a.pingSum / a.pingN) : null, epochs: live.monitor?.rtcm?.epochs || 0, missedEpochs: live.monitor?.rtcm?.missed || 0, gradeSec: a.gradeSec } : null });
  }
  const everBase = projects.readBase(P, mount);
  const firstEver = Math.min(...everBase.map(r => r.start), live?.connectedAt ?? Infinity);
  const measuredFrom = Number.isFinite(firstEver) && firstEver > from ? firstEver : from;
  const online = merge(baseRecs.map(r => [Math.max(r.start, from), Math.min(r.end, end)]));
  const onlineMs = online.reduce((a, [x, y]) => a + (y - x), 0);
  const outages = [];
  let cursor = measuredFrom;
  for (const [a, b] of online) { if (a - cursor >= 60_000) outages.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (end - cursor >= 60_000 && measuredFrom < end) outages.push([cursor, end]);
  const baseBytes = baseRecs.reduce((a, r) => {
    const f = r.end > r.start ? (Math.min(r.end, end) - Math.max(r.start, from)) / (r.end - r.start) : 0;
    return a + (r.bytes || 0) * Math.max(0, f);
  }, 0);
  const lastBase = baseRecs.sort((a, b) => b.end - a.end)[0];
  const types = [...new Set(baseRecs.flatMap(r => r.messageTypes || []))].sort((a, b) => a - b);
  const formats = [...new Set(baseRecs.map(r => r.format).filter(Boolean))];

  // Rover sessions on this mountpoint, cut to the month
  const history = projects.historyFor(P);
  const devices = projects.devicesFor(P);
  const sessions = [];
  const serials = fs.existsSync(history.dir) ? fs.readdirSync(history.dir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)) : [];
  for (const serial of serials) {
    for (const r of history.read(serial, { fromMs: from, limit: 1e7 })) {
      if (r.type !== 'session' || r.mount !== mount || r.end <= from || r.start >= end) continue;
      sessions.push({ ...r, serial });
    }
  }
  for (const c of state.clients.values()) {
    if (c.project !== P || c.mount !== mount) continue;
    const f = c.fixMs || {};
    const s = ms => Math.round((ms || 0) / 1000);
    const other = Object.entries(f).filter(([k]) => !['0', '4', '5', 'gap'].includes(k)).reduce((a, [, v]) => a + v, 0);
    sessions.push({
      type: 'session', serial: c.serial, label: c.label, start: c.connectedAt, end: now, durationSec: s(now - c.connectedAt), mount, protocol: c.protocol, addr: c.addr,
      bytes: c.bytesOut, endReason: 'still connected', fixSec: { fixed: s(f[4]), float: s(f[5]), other: s(other), none: s((f[0] || 0) + (f.gap || 0)) },
      lateCorrectionsSec: s(c.lateMs), net: c.netAcc?.n ? { avgPingMs: Math.round(c.netAcc.pingSum / c.netAcc.n), maxPingMs: c.netAcc.pingMax, gradeSec: c.netAcc.gradeSec } : null, live: true,
    });
  }
  for (const r of sessions) {
    const len = Math.max(1, r.end - r.start);
    r.inStart = Math.max(r.start, from);
    r.inEnd = Math.min(r.end, end);
    r.share = (r.inEnd - r.inStart) / len;
    r.inMs = r.inEnd - r.inStart;
    const d = devices.get(r.serial);
    r.machine = d?.label || r.label || r.serial;
    r.company = d?.profile?.companyName || '';
    r.operator = d?.profile?.operatorName || '';
    r.deleted = !d;
  }
  sessions.sort((a, b) => a.inStart - b.inStart);

  // Per machine
  const machines = new Map();
  for (const r of sessions) {
    const m = machines.get(r.serial) || { serial: r.serial, machine: r.machine, company: r.company, operator: r.operator, deleted: r.deleted, sessions: 0, ms: 0, bytes: 0, fix: { fixed: 0, float: 0, other: 0, none: 0 }, first: Infinity, last: 0, pingSum: 0, pingW: 0, grade: { excellent: 0, good: 0, fair: 0, poor: 0 }, lateSec: 0 };
    m.sessions++;
    m.ms += r.inMs;
    m.bytes += (r.bytes || 0) * r.share;
    for (const k of Object.keys(m.fix)) m.fix[k] += (r.fixSec?.[k] || 0) * r.share;
    m.first = Math.min(m.first, r.inStart);
    m.last = Math.max(m.last, r.inEnd);
    m.lateSec += (r.lateCorrectionsSec || 0) * r.share;
    if (r.net) {
      m.pingSum += r.net.avgPingMs * r.inMs; m.pingW += r.inMs;
      for (const k of Object.keys(m.grade)) m.grade[k] += (r.net.gradeSec?.[k] || 0) * r.share;
    }
    machines.set(r.serial, m);
  }
  const machineList = [...machines.values()].sort((a, b) => b.ms - a.ms);
  // Per company
  const companies = new Map();
  for (const m of machineList) {
    const k = m.company || '(no company)';
    const c = companies.get(k) || { company: k, machines: 0, sessions: 0, ms: 0, bytes: 0, fixed: 0, fixTotal: 0 };
    c.machines++; c.sessions += m.sessions; c.ms += m.ms; c.bytes += m.bytes;
    c.fixed += m.fix.fixed; c.fixTotal += m.fix.fixed + m.fix.float + m.fix.other + m.fix.none;
    companies.set(k, c);
  }
  const companyList = [...companies.values()].sort((a, b) => b.ms - a.ms);
  // Most machines at once
  const edges = [];
  for (const r of sessions) { edges.push([r.inStart, 1], [r.inEnd, -1]); }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, peakAt = null;
  for (const [t, d] of edges) { cur += d; if (cur > peak) { peak = cur; peakAt = t; } }
  // Machine-hours per day
  const tz = config.reportTimeZone;
  const days = [];
  for (let t = from; t < to; ) {
    const k = dayKey(tz, t + 2 * HOUR);
    const [dd, mm, yy] = k.split('/').map(Number);
    const next = localMidnight(tz, yy, mm, dd + 1);
    days.push({ key: k, label: String(dd), from: t, to: next, ms: 0, baseMs: 0 });
    t = next;
  }
  for (const d of days) {
    for (const r of sessions) d.ms += Math.max(0, Math.min(r.inEnd, d.to) - Math.max(r.inStart, d.from));
    for (const [a, b] of online) d.baseMs += Math.max(0, Math.min(b, d.to) - Math.max(a, d.from));
  }
  // Refused logins on this mountpoint, and changes to the project
  const events = projects.readEvents(P, { limit: 1e7 }).filter(e => { const t = Date.parse(e.time); return t >= from && t < end; });
  const refused = events.filter(e => e.type === 'rover.rejected' && e.mount === mount);
  const positionEvents = events.filter(e => e.mount === mount && /^mountpoint\.position_/.test(e.type));
  const changes = events.filter(e => /^(device\.(added|updated|removed|credentials_emailed)|devices\.(imported|exported)|project\.\w+|receiver\.(added|updated|removed)|mountpoint\.(removed|position_set|position_cleared))$/.test(e.type));
  const totals = machineList.reduce((a, m) => ({ ms: a.ms + m.ms, bytes: a.bytes + m.bytes, fixed: a.fixed + m.fix.fixed, fixAll: a.fixAll + m.fix.fixed + m.fix.float + m.fix.other + m.fix.none }), { ms: 0, bytes: 0, fixed: 0, fixAll: 0 });
  // The base's connection over the month (connections recorded since this was measured)
  const bn = { latW: 0, latSum: 0, latMax: 0, pingW: 0, pingSum: 0, epochs: 0, missed: 0, grade: { excellent: 0, good: 0, fair: 0, poor: 0 } };
  for (const r of baseRecs) {
    if (!r.net) continue;
    const share = r.end > r.start ? Math.max(0, (Math.min(r.end, end) - Math.max(r.start, from)) / (r.end - r.start)) : 0;
    const w = (r.end - r.start) * share;
    if (r.net.avgLatencyMs != null) { bn.latW += w; bn.latSum += r.net.avgLatencyMs * w; bn.latMax = Math.max(bn.latMax, r.net.maxLatencyMs || 0); }
    if (r.net.avgPingMs != null) { bn.pingW += w; bn.pingSum += r.net.avgPingMs * w; }
    bn.epochs += (r.net.epochs || 0) * share; bn.missed += (r.net.missedEpochs || 0) * share;
    for (const k of Object.keys(bn.grade)) bn.grade[k] += (r.net.gradeSec?.[k] || 0) * share;
  }
  return { baseNet: bn, from, to, end, span, measuredFrom, onlineMs, online, outages, baseBytes, lastBase, types, formats, sessions, machineList, companyList, peak, peakAt, days, refused, positionEvents, changes, totals };
}

/** True when a mountpoint had a base or a machine connected during the month (or is still connected). */
function hadActivity({ state, projects, projectId: P, mount, from, to }) {
  if (state.sources.has(mount)) return true;
  if (projects.readBase(P, mount).some(r => r.end > from && r.start < to)) return true;
  for (const c of state.clients.values()) if (c.project === P && c.mount === mount) return true;
  return false;
}

// ---------------------------------------------------------------- PDF
const C = { ink: '#1b1f24', muted: '#5f6b76', line: '#d9dee3', brand: '#0063a3', soft: '#f3f5f7', good: '#1e8e3e', warn: '#e37400', bad: '#d93025' };

function makePdf(file, render) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 52, left: 44, right: 44 }, bufferPages: true, info: { Title: REPORT_NAME, Producer: 'Connect-NTRIP' } });
    const out = fs.createWriteStream(file + '.tmp', { mode: 0o600 });
    doc.pipe(out);
    out.on('finish', () => { fs.renameSync(file + '.tmp', file); resolve(); });
    out.on('error', reject);
    Promise.resolve(render(doc)).then(() => doc.end(), reject);
  });
}

function pdfHelpers(doc, footer) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = h => { if (doc.y + h > bottom()) doc.addPage(); };
  const heading = text => {
    ensure(60);
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.brand).text(text, L, doc.y);
    doc.moveTo(L, doc.y + 2).lineTo(L + W, doc.y + 2).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.moveDown(0.5);
    doc.fillColor(C.ink);
  };
  const note = text => { doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(text, L, doc.y, { width: W }); doc.fillColor(C.ink); doc.moveDown(0.3); };
  const kv = rows => {
    for (const [k, v] of rows) {
      ensure(16);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(k, L, y, { width: 130 });
      doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(String(v), L + 135, y, { width: W - 135 });
      doc.y = Math.max(doc.y, y + 13);
    }
  };
  /** cols: [{ label, width (share), align }] rows: string[][] */
  const table = (cols, rows, { empty = 'None.', bold = [] } = {}) => {
    const total = cols.reduce((a, c) => a + c.w, 0);
    const xs = []; let x = L;
    for (const c of cols) { xs.push(x); x += (c.w / total) * W; }
    const widths = cols.map(c => (c.w / total) * W);
    const head = () => {
      ensure(30);
      const y = doc.y;
      doc.rect(L, y - 2, W, 15).fill(C.soft);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted);
      cols.forEach((c, i) => doc.text(c.label.toUpperCase(), xs[i] + 3, y + 2, { width: widths[i] - 6, align: c.align || 'left', lineBreak: false, ellipsis: true }));
      doc.y = y + 16;
      doc.fillColor(C.ink);
    };
    head();
    if (!rows.length) { note(empty); return; }
    rows.forEach((row, ri) => {
      doc.font('Helvetica').fontSize(8.5);
      const h = Math.max(...row.map((cell, i) => doc.heightOfString(String(cell ?? ''), { width: widths[i] - 6 }))) + 5;
      if (doc.y + h > bottom()) { doc.addPage(); head(); }
      const y = doc.y;
      doc.font(bold.includes(ri) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(C.ink);
      row.forEach((cell, i) => doc.text(String(cell ?? ''), xs[i] + 3, y + 2, { width: widths[i] - 6, align: cols[i].align || 'left' }));
      doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.3).strokeColor(C.line).stroke();
      doc.y = y + h + 1;
    });
    doc.moveDown(0.3);
  };
  const tiles = items => {
    ensure(60);
    const gap = 8, w = (W - gap * (items.length - 1)) / items.length, y = doc.y;
    items.forEach(([value, label, colour], i) => {
      const x = L + i * (w + gap);
      doc.roundedRect(x, y, w, 46, 4).fill(C.soft);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(colour || C.ink).text(value, x + 8, y + 8, { width: w - 16, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label, x + 8, y + 29, { width: w - 16, lineBreak: false, ellipsis: true });
    });
    doc.y = y + 56;
    doc.fillColor(C.ink);
  };
  const footers = () => {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - 34;
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing in the bottom margin must not start a new page
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(`${footer} · page ${i + 1} of ${range.count}`, L, y, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
  };
  return { W, L, ensure, heading, note, kv, table, tiles, footers, bottom };
}

async function renderReport(doc, d) {
  const { g, tz } = d;
  const H = pdfHelpers(doc, `${REPORT_NAME} · ${d.mount} · ${d.monthTitle}`);
  const { W, L } = H;

  // Title
  doc.font('Helvetica-Bold').fontSize(19).fillColor(C.ink).text(REPORT_NAME, L, doc.y);
  doc.font('Helvetica').fontSize(11).fillColor(C.muted).text(`${d.mount} · ${d.projectName} · ${d.monthTitle}${d.partial ? ' (month to date)' : ''}`);
  doc.fontSize(8.5).text(`${d.casterName} · ${fmt(tz, g.from, { day: 'numeric', month: 'short', year: 'numeric' })} to ${fmt(tz, g.end - 1, { day: 'numeric', month: 'short', year: 'numeric' })} (${tz}) · generated ${fmt(tz, d.now, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  doc.moveDown(0.8);

  const measured = g.end - g.measuredFrom;
  const avail = pct(g.onlineMs, measured);
  const fixedPct = pct(g.totals.fixed, g.totals.fixAll);
  H.tiles([
    [`${avail.toFixed(1)}%`, 'Base availability', avail >= 99 ? C.good : avail >= 95 ? C.warn : C.bad],
    [String(g.machineList.length), 'Machines served'],
    [h1(g.totals.ms), 'Machine-hours'],
    [g.totals.fixAll ? `${fixedPct.toFixed(0)}%` : '—', 'Time RTK fixed', fixedPct >= 90 ? C.good : fixedPct >= 70 ? C.warn : C.bad],
    [String(g.refused.length), 'Refused logins', g.refused.length ? C.warn : C.ink],
  ]);

  // Base station
  H.heading('Base station');
  const types = g.types;
  const fmtLabel = types.length ? rtcmLabel(types) : (g.formats[0] || d.format || '—');
  H.kv([
    ['Mountpoint', d.mount],
    ...(d.receiverName ? [['Base receiver', d.receiverName]] : []),
    ['Format', fmtLabel + (g.formats.length > 1 ? ` (also ${g.formats.filter(f => f !== fmtLabel).join(', ')})` : '')],
    ...(systems(types).length ? [['Satellite systems', systems(types).join(', ')]] : []),
    ...(types.length ? [['RTCM messages', types.join(', ')]] : []),
    ['Data from the base', `${mb(g.baseBytes)} (${g.onlineMs ? `${(g.baseBytes / (g.onlineMs / 1000)).toFixed(0)} bytes/s while online` : 'no data'})`],
  ]);
  {
    const b = g.baseNet;
    const gt = b.grade.excellent + b.grade.good + b.grade.fair + b.grade.poor;
    if (gt || b.latW || b.pingW) {
      H.kv([
        ['Latency', b.latW ? `${Math.round(b.latSum / b.latW)} ms average, ${b.latMax} ms worst (base epoch time to arrival at the caster)` : 'Not in this stream\'s data (no RTCM MSM epoch times)'],
        ...(b.pingW ? [['Network round trip', `${Math.round(b.pingSum / b.pingW)} ms average`]] : []),
        ...(b.epochs ? [['Missed epochs', `${pct(b.missed, b.epochs + b.missed).toFixed(2)}% (${Math.round(b.missed)} of ${Math.round(b.epochs + b.missed)})`]] : []),
        ...(gt ? [['Connection', `Excellent ${pct0(b.grade.excellent, gt)} · Good ${pct0(b.grade.good, gt)} · Fair ${pct0(b.grade.fair, gt)} · Poor ${pct0(b.grade.poor, gt)} of the time online`]] : []),
      ]);
    }
  }
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(10).text('Base position', L, doc.y);
  doc.moveDown(0.2);
  if (d.position) {
    H.kv([...(await positionRows(d.position, d.geo)), ['Source', d.position.from || '—'], ...(d.geo?.crsName ? [['Coordinate system', d.geo.crsName]] : [])]);
    if (!d.geo?.proj4) H.note('Easting and northing appear once a project admin has opened the extension in Connect (it tells the caster the project\'s coordinate system).');
  } else H.note('No position known for this base.');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text('Position changes this month', L, doc.y);
  doc.moveDown(0.2);
  H.table([{ label: 'When', w: 2 }, { label: 'Change', w: 6 }], g.positionEvents.map(e => [dateTime(tz, Date.parse(e.time)),
    e.type === 'mountpoint.position_changed' ? `Base data moved ${e.movedM} m horizontally${e.heightChangeM ? `, ${e.heightChangeM > 0 ? '+' : ''}${e.heightChangeM} m in height` : ''} (now ${Number(e.lat).toFixed(8)}, ${Number(e.lon).toFixed(8)})`
      : e.type === 'mountpoint.position_detected' ? `Position first received from the base's data (${Number(e.lat).toFixed(8)}, ${Number(e.lon).toFixed(8)})`
        : e.type === 'mountpoint.position_set' ? `Position set by hand by ${e.by}` : `Position set by hand cleared by ${e.by}`]), { empty: 'No changes: the base stayed where it was.' });

  // Availability
  H.heading('Availability');
  H.kv([
    ['Online', `${avail.toFixed(2)}% (${durText(g.onlineMs)} of ${durText(measured)})${g.measuredFrom > g.from ? ` · measured from the base's first connection, ${dateTime(tz, g.measuredFrom)}` : ''}`],
    ['Outages', `${g.outages.length}${g.outages.length ? ` · longest ${durText(Math.max(...g.outages.map(([a, b]) => b - a)))} · total ${durText(g.outages.reduce((a, [x, y]) => a + y - x, 0))}` : ''}`],
  ]);
  // Strip: one bar per day, green where the base was online
  H.ensure(70);
  {
    const y = doc.y + 4, h = 18, n = g.days.length, w = W / n;
    g.days.forEach((day, i) => {
      const x = L + i * w;
      doc.rect(x + 0.5, y, w - 1, h).fill(day.from >= g.end || day.to <= g.measuredFrom ? '#eceff2' : '#f6d5d2');
      for (const [a, b] of g.online) {
        const s = Math.max(a, day.from), e = Math.min(b, day.to);
        if (e > s) doc.rect(x + 0.5 + ((s - day.from) / (day.to - day.from)) * (w - 1), y, ((e - s) / (day.to - day.from)) * (w - 1), h).fill(C.good);
      }
      if (n <= 31) doc.font('Helvetica').fontSize(6).fillColor(C.muted).text(day.label, x, y + h + 2, { width: w, align: 'center', lineBreak: false });
    });
    doc.y = y + h + 14;
    H.note('Each column is a day: green = base online, red = offline, grey = before the base was set up or still to come.');
  }
  H.table([{ label: 'Outage started', w: 2 }, { label: 'Ended', w: 2 }, { label: 'Length', w: 1.4, align: 'right' }],
    g.outages.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 20).sort((a, b) => a[0] - b[0]).map(([a, b]) => [dateTime(tz, a), b >= g.end && d.partial ? 'still offline' : dateTime(tz, b), durText(b - a)]),
    { empty: 'No outages longer than a minute.' });
  if (g.outages.length > 20) H.note(`The 20 longest of ${g.outages.length} outages are listed; the CSV has every base connection.`);

  // Machines
  H.heading('Machines');
  H.kv([
    ['Machines', `${g.machineList.length} (${g.sessions.length} sessions)`],
    ['Most at once', g.peak ? `${g.peak} at ${dateTime(tz, g.peakAt)}` : '—'],
    ['Corrections sent', mb(g.totals.bytes)],
  ]);
  doc.moveDown(0.2);
  H.table([
    { label: 'Machine', w: 2.2 }, { label: 'Serial', w: 1.6 }, { label: 'Company', w: 1.7 }, { label: 'Operator', w: 1.5 }, { label: 'Sessions', w: 1.15, align: 'right' },
    { label: 'Hours', w: 0.9, align: 'right' }, { label: 'Fixed', w: 0.8, align: 'right' }, { label: 'Float', w: 0.8, align: 'right' }, { label: 'Data', w: 1, align: 'right' }, { label: 'Last seen', w: 1.5 },
  ], g.machineList.map(m => {
    const all = m.fix.fixed + m.fix.float + m.fix.other + m.fix.none;
    return [m.machine + (m.deleted ? ' (login deleted)' : ''), m.serial, m.company || '—', m.operator || '—', m.sessions, h1(m.ms), all ? pct0(m.fix.fixed, all) : '—', all ? pct0(m.fix.float, all) : '—', mb(m.bytes), dateTime(tz, m.last)];
  }), { empty: 'No machines connected this month.' });

  // Companies
  H.heading('Hours by company');
  const cRows = g.companyList.map(c => [c.company, c.machines, c.sessions, h1(c.ms), pct0(c.ms, g.totals.ms), c.fixTotal ? pct0(c.fixed, c.fixTotal) : '—', mb(c.bytes)]);
  if (cRows.length) cRows.push(['Total', g.machineList.length, g.sessions.length, h1(g.totals.ms), '100%', g.totals.fixAll ? pct0(g.totals.fixed, g.totals.fixAll) : '—', mb(g.totals.bytes)]);
  H.table([{ label: 'Company', w: 3 }, { label: 'Machines', w: 1, align: 'right' }, { label: 'Sessions', w: 1, align: 'right' }, { label: 'Machine-hours', w: 1.3, align: 'right' }, { label: 'Share', w: 0.9, align: 'right' }, { label: 'Fixed', w: 0.9, align: 'right' }, { label: 'Data', w: 1.1, align: 'right' }],
    cRows, { empty: 'No machines connected this month.', bold: cRows.length ? [cRows.length - 1] : [] });
  H.note('Machine-hours are time connected to this mountpoint. The company is taken from each login\'s details.');

  // Daily chart
  H.heading('Machine-hours per day');
  H.ensure(150);
  {
    const y0 = doc.y + 6, h = 110, n = g.days.length, w = W / n;
    const max = Math.max(1, ...g.days.map(x => hours(x.ms)));
    const step = max > 200 ? 50 : max > 80 ? 20 : max > 40 ? 10 : max > 16 ? 5 : max > 6 ? 2 : 1;
    const top = Math.ceil(max / step) * step;
    doc.font('Helvetica').fontSize(6.5).fillColor(C.muted);
    for (let v = 0; v <= top; v += step) {
      const yy = y0 + h - (v / top) * h;
      doc.moveTo(L + 18, yy).lineTo(L + W, yy).lineWidth(0.3).strokeColor(C.line).stroke();
      doc.text(String(v), L, yy - 3, { width: 15, align: 'right', lineBreak: false });
    }
    const bw = (W - 20) / n;
    g.days.forEach((day, i) => {
      const bh = (hours(day.ms) / top) * h;
      const x = L + 20 + i * bw;
      if (bh > 0) doc.rect(x + bw * 0.15, y0 + h - bh, bw * 0.7, bh).fill(C.brand);
      if (n <= 31) doc.font('Helvetica').fontSize(6).fillColor(C.muted).text(day.label, x, y0 + h + 3, { width: bw, align: 'center', lineBreak: false });
    });
    doc.y = y0 + h + 16;
    doc.fillColor(C.ink);
  }

  // Connection quality
  H.heading('Connection quality');
  H.note('Measured by the caster from each machine\'s network link (ping, and data that had to be resent) and the age of corrections the machine reported. Machines connected before this was recorded show no figures.');
  H.table([{ label: 'Machine', w: 2.4 }, { label: 'Avg ping', w: 1, align: 'right' }, { label: 'Excellent', w: 1, align: 'right' }, { label: 'Good', w: 0.8, align: 'right' }, { label: 'Fair', w: 0.8, align: 'right' }, { label: 'Poor', w: 0.8, align: 'right' }, { label: 'Late corr. (>3 s)', w: 1.4, align: 'right' }],
    g.machineList.map(m => {
      const gt = m.grade.excellent + m.grade.good + m.grade.fair + m.grade.poor;
      return [m.machine, m.pingW ? `${Math.round(m.pingSum / m.pingW)} ms` : '—', gt ? pct0(m.grade.excellent, gt) : '—', gt ? pct0(m.grade.good, gt) : '—', gt ? pct0(m.grade.fair, gt) : '—', gt ? pct0(m.grade.poor, gt) : '—', m.ms ? pct0(m.lateSec * 1000, m.ms) : '—'];
    }), { empty: 'No machines connected this month.' });

  // Refused logins
  H.heading('Refused logins');
  if (!g.refused.length) H.note('None this month.');
  else {
    const by = (key) => { const m = new Map(); for (const e of g.refused) m.set(e[key] || '—', (m.get(e[key] || '—') || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
    H.table([{ label: 'Reason', w: 3 }, { label: 'Times', w: 1, align: 'right' }], by('reason').map(([k, v]) => [k, v]));
    H.table([{ label: 'Username (serial)', w: 2 }, { label: 'Times', w: 0.8, align: 'right' }, { label: 'Last tried', w: 1.6 }, { label: 'From', w: 2 }],
      by('serial').slice(0, 15).map(([s, v]) => { const last = g.refused.filter(e => (e.serial || '—') === s).sort((a, b) => b.time.localeCompare(a.time))[0]; return [s, v, dateTime(tz, Date.parse(last.time)), String(last.addr || '').replace(/:\d+$/, '')]; }));
  }

  // Changes
  H.heading('Changes to the project this month');
  H.note('Project-wide: logins, base password and base receivers (the same list appears in each mountpoint\'s report).');
  const describe = e => {
    switch (e.type) {
      case 'device.added': return `Login ${e.serial} added`;
      case 'device.updated': return `Login ${e.serial} changed (${(e.fields || []).join(', ')})`;
      case 'device.removed': return `Login ${e.serial} deleted`;
      case 'device.credentials_emailed': return `Login details for ${e.serial} emailed to ${e.to}`;
      case 'devices.imported': return `Logins imported: ${e.added} added, ${e.replaced} replaced, ${e.skipped} skipped`;
      case 'devices.exported': return `${e.count} logins exported`;
      case 'project.base_password_changed': return 'Base password changed';
      case 'project.took_over_existing': return 'Existing bases and logins moved into this project';
      case 'receiver.added': return `Base receiver ${e.name || e.receiver} added`;
      case 'receiver.updated': return `Base receiver ${e.receiver} changed`;
      case 'receiver.removed': return `Base receiver ${e.receiver} removed`;
      case 'mountpoint.removed': return `Mountpoint ${e.mount} removed`;
      case 'mountpoint.position_set': return `Position of ${e.mount} set by hand`;
      case 'mountpoint.position_cleared': return `Position set by hand for ${e.mount} cleared`;
      default: return e.type;
    }
  };
  H.table([{ label: 'When', w: 1.3 }, { label: 'Change', w: 3.9 }, { label: 'By', w: 2.8 }], g.changes.slice(-200).map(e => [dateTime(tz, Date.parse(e.time)), describe(e), e.by || '—']), { empty: 'No changes this month.' });
  if (g.changes.length > 200) H.note(`The last 200 of ${g.changes.length} changes are listed.`);

  H.footers();
}

// ---------------------------------------------------------------- CSV
function csv(rows) {
  const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
function sessionsCsv(d) {
  const { g, tz } = d;
  const iso = ms => new Date(ms).toISOString();
  const local = ms => fmt(tz, ms, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const rows = [['Type', 'Mountpoint', 'Serial', 'Machine', 'Company', 'Operator', `Start (${tz})`, `End (${tz})`, 'Start (UTC)', 'End (UTC)', 'Hours in month', 'Data (MB)', 'RTK fixed %', 'Float %', 'Other fix %', 'No position %', 'Avg ping (ms)', 'Late corrections (s)', 'Address', 'Ended']];
  for (const r of g.sessions) {
    const f = r.fixSec || {}; const all = (f.fixed || 0) + (f.float || 0) + (f.other || 0) + (f.none || 0);
    rows.push(['Machine', d.mount, r.serial, r.machine, r.company, r.operator, local(r.inStart), local(r.inEnd), iso(r.inStart), iso(r.inEnd), hours(r.inMs).toFixed(3), (((r.bytes || 0) * r.share) / 1048576).toFixed(3),
      all ? pct(f.fixed, all).toFixed(1) : '', all ? pct(f.float, all).toFixed(1) : '', all ? pct(f.other, all).toFixed(1) : '', all ? pct(f.none, all).toFixed(1) : '',
      r.net?.avgPingMs ?? '', Math.round((r.lateCorrectionsSec || 0) * r.share), r.addr || '', r.endReason || '']);
  }
  const bases = d.projects.readBase(d.projectId, d.mount).filter(r => r.end > g.from && r.start < g.end);
  for (const r of bases) {
    const s = Math.max(r.start, g.from), e = Math.min(r.end, g.end), share = (e - s) / Math.max(1, r.end - r.start);
    rows.push(['Base', d.mount, '', '', '', '', local(s), local(e), iso(s), iso(e), hours(e - s).toFixed(3), (((r.bytes || 0) * share) / 1048576).toFixed(3), '', '', '', '', '', '', r.addr || '', r.endReason || '']);
  }
  for (const e of g.refused) rows.push(['Refused login', d.mount, e.serial || '', '', '', '', local(Date.parse(e.time)), '', e.time, '', '', '', '', '', '', '', '', '', e.addr || '', e.reason || '']);
  return csv(rows);
}

// ---------------------------------------------------------------- building and storing
export function reportsDir(projects, projectId) {
  return path.join(projects.projectDir(projectId), 'reports');
}

/**
 * Builds the reports for one month of a project, one per mountpoint that had activity. With `store` false the
 * files go to a temporary folder (a preview of a month still in progress).
 */
export async function buildMonth({ config, state, projects, projectId, month, store = true }) {
  const tz = config.reportTimeZone;
  const now = Date.now();
  const { from, to } = monthRange(tz, month);
  if (from > now) throw new Error('That month has not started yet');
  const partial = to > now;
  const project = projects.get(projectId);
  const dir = store ? path.join(reportsDir(projects, projectId), month) : fs.mkdtempSync(path.join(projects.projectDir(projectId), '.preview-'));
  fs.mkdirSync(dir, { recursive: true });
  const known = new Set(config.mountpoints.filter(m => projects.projectOf(m) === projectId).map(m => m.name));
  // Mountpoints removed since still get a report for months they were used
  const baseDir = path.dirname(projects.baseFile(projectId, 'x'));
  for (const f of fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : []) if (f.endsWith('.jsonl')) known.add(f.slice(0, -6));
  const made = [];
  for (const mount of [...known].sort()) {
    if (!hadActivity({ state, projects, projectId, mount, from, to })) continue;
    const g = gather({ config, state, projects, projectId, mount, from, to, now });
    const m = config.mountpoints.find(x => x.name === mount);
    const view = m ? state.sourceView(m) : null;
    const receiver = config.receivers.find(r => r.mountpoints?.includes(mount));
    const d = {
      config, projects, projectId, mount, g, tz, now, partial, month, monthTitle: monthTitle(month), casterName: config.casterName || 'NTRIP caster',
      projectName: project?.name || projectId, receiverName: receiver?.name || null, geo: project?.geo || null,
      position: view?.position || (g.lastBase?.position ?? null), format: m?.format,
    };
    const pdf = path.join(dir, `${mount}.pdf`);
    await makePdf(pdf, doc => renderReport(doc, d));
    fs.writeFileSync(path.join(dir, `${mount}.csv`), '﻿' + sessionsCsv(d), { mode: 0o600 });
    made.push({ mount, pdf, csv: path.join(dir, `${mount}.csv`), dir });
    if (store) state.event('report.generated', { project: projectId, mount, month });
  }
  if (store) {
    const metaFile = path.join(dir, 'meta.json');
    const meta = readMeta(metaFile);
    meta.generatedAt = new Date(now).toISOString();
    meta.mounts = made.map(x => x.mount);
    writeMeta(metaFile, meta);
  }
  return { month, dir, partial, reports: made };
}

function readMeta(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { uploaded: {} }; } }
function writeMeta(f, m) { fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); }

/** Every stored report of a project, oldest month first, with whether it has been saved to the Connect project. */
export function listReports(projects, projectId) {
  const root = reportsDir(projects, projectId);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const month of fs.readdirSync(root).filter(n => /^\d{4}-\d{2}$/.test(n)).sort()) {
    const meta = readMeta(path.join(root, month, 'meta.json'));
    for (const mount of meta.mounts || []) out.push({ month, mount, generatedAt: meta.generatedAt, uploadedAt: meta.uploaded?.[mount]?.at || null, uploadedBy: meta.uploaded?.[mount]?.by || null });
  }
  return out;
}

export function reportFile(projects, projectId, month, mount, ext) {
  if (!/^\d{4}-\d{2}$/.test(month) || !/^[A-Za-z0-9_\-]{1,100}$/.test(mount) || !['pdf', 'csv'].includes(ext)) return null;
  const f = path.join(reportsDir(projects, projectId), month, `${mount}.${ext}`);
  return fs.existsSync(f) ? f : null;
}

export function markUploaded(projects, projectId, month, mount, by) {
  const f = path.join(reportsDir(projects, projectId), month, 'meta.json');
  const meta = readMeta(f);
  if (!(meta.mounts || []).includes(mount)) return false;
  meta.uploaded ??= {};
  meta.uploaded[mount] = { at: new Date().toISOString(), by };
  writeMeta(f, meta);
  return true;
}

/** Builds last month's reports for every project shortly after the month ends (checked every 10 minutes). */
export function startReports({ config, state, projects }) {
  const run = async () => {
    const tz = config.reportTimeZone;
    const month = previousMonth(monthOf(tz, Date.now()));
    const { to } = monthRange(tz, month);
    if (Date.now() < to + 5 * 60_000) return;
    for (const p of projects.list()) {
      if (fs.existsSync(path.join(reportsDir(projects, p.id), month, 'meta.json'))) continue;
      try {
        const r = await buildMonth({ config, state, projects, projectId: p.id, month });
        if (r.reports.length) console.log(`Monthly reports for ${p.name || p.id}, ${month}: ${r.reports.map(x => x.mount).join(', ')}`);
      } catch (err) {
        console.error(`Monthly report for ${p.id} ${month} failed: ${err.stack || err.message}`);
      }
    }
  };
  setTimeout(() => void run(), 30_000).unref();
  setInterval(() => void run(), 10 * 60_000).unref();
}
