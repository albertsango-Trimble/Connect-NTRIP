// Watches the caster: CPU and memory, API response time, and the extension's live feed for one project
import fs from 'node:fs';
import WebSocket from 'ws';
const [pid, project = 'local-dev'] = process.argv.slice(2);
const API = 'http://127.0.0.1:38080';
const H = { Authorization: 'Bearer devtoken123', 'X-Connect-Project': project };
let lastCpu = null, ticks = [], tickBytes = 0, lastTick = null;
const ws = new WebSocket('ws://127.0.0.1:38080/ws', { headers: { Origin: 'http://localhost:5173' }, perMessageDeflate: true });
let wire = 0, lastWire = 0;
ws.on('upgrade', res => { res.socket.on('data', d => { wire += d.length; }); });
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'devtoken123', project })));
ws.on('message', m => { const x = JSON.parse(m); if (x.type === 'tick') { const now = Date.now(); if (lastTick) ticks.push(now - lastTick); lastTick = now; tickBytes = m.length; } });
const t0 = Date.now();
setInterval(async () => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const cpu = Number(stat[11]) + Number(stat[12]); const now = Date.now();
  const rss = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;
  const pct = lastCpu ? ((cpu - lastCpu.cpu) / 100) / ((now - lastCpu.at) / 1000) * 100 : null; lastCpu = { cpu, at: now };
  let health = null, snap = null, snapKB = null;
  try { const a = Date.now(); await fetch(API + '/api/health'); health = Date.now() - a; } catch {}
  try { const a = Date.now(); const r = await fetch(API + '/api/snapshot', { headers: H }); const t = await r.text(); snap = Date.now() - a; snapKB = Math.round(t.length / 1024); } catch {}
  const tk = ticks.sort((x, y) => x - y); ticks = [];
  console.log(JSON.stringify({ t: Math.round((now - t0) / 1000), cpuPct: pct && Math.round(pct), rssMB: Math.round(rss), healthMs: health, snapshotMs: snap, snapshotKB: snapKB, tickGapMaxMs: tk.length ? tk[tk.length - 1] : null, tickKB: Math.round(tickBytes / 1024), wireKBps: Math.round((wire - lastWire) / 5 / 1024) })); lastWire = wire;
}, 5000);
