import fs from 'node:fs';
import path from 'node:path';
import { AutoMountpoints } from './automounts.js';

const CONFIG_PATH = process.env.CASTER_CONFIG || path.resolve('config.json');

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Environment overrides (handy for secrets on the VM)
  if (process.env.NTRIP_PORT) cfg.ntripPort = Number(process.env.NTRIP_PORT);
  if (process.env.DASHBOARD_PORT) cfg.dashboardPort = Number(process.env.DASHBOARD_PORT);
  if (process.env.DASHBOARD_TOKEN) cfg.dashboardToken = process.env.DASHBOARD_TOKEN;
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;

  cfg.ntripPort ??= 2101;
  cfg.dashboardPort ??= 8080;
  cfg.dataDir = path.resolve(cfg.dataDir || './data');
  cfg.adminEmails = (cfg.adminEmails || []).map(e => e.toLowerCase().trim());
  cfg.allowedOrigins ??= [];
  cfg.tcApiHosts ??= ['https://app.connect.trimble.com/tc/api/2.0'];
  cfg.sourceIdleTimeoutSec ??= 60;
  cfg.historyDays ??= 365; // how long each rover's online history is kept (0 = forever)
  cfg.mountpoints ??= [];

  const names = new Set();
  for (const m of cfg.mountpoints) {
    if (!/^[A-Za-z0-9_\-]{1,100}$/.test(m.name)) throw new Error(`Invalid mountpoint name: ${m.name}`);
    if (names.has(m.name)) throw new Error(`Duplicate mountpoint: ${m.name}`);
    if (!m.sourcePassword) throw new Error(`Mountpoint ${m.name} needs a sourcePassword`);
    names.add(m.name);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  // Mountpoints the bases named themselves (kept from earlier runs); also lets receivers refer to them
  cfg.autoMounts = new AutoMountpoints(cfg);
  for (const m of cfg.mountpoints) names.add(m.name);
  if (!cfg.mountpoints.length && !cfg.autoMounts.enabled) console.warn('No mountpoints configured and autoMountpoints is off: no base can connect.');

  // Base receivers whose own web interface can be opened from the extension
  cfg.receivers ??= [];
  cfg.webUi = { port: 8081, ...(cfg.webUi || {}) };
  if (process.env.WEBUI_PORT) cfg.webUi.port = Number(process.env.WEBUI_PORT);
  const ids = new Set();
  for (const r of cfg.receivers) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(r.id || '')) throw new Error(`Receiver id "${r.id}" must be lower-case letters, digits and dashes (it becomes part of a web address)`);
    if (ids.has(r.id)) throw new Error(`Duplicate receiver id: ${r.id}`);
    ids.add(r.id);
    r.mountpoints ??= [];
    for (const mp of r.mountpoints) if (!names.has(mp)) throw new Error(`Receiver ${r.id} lists unknown mountpoint ${mp}`);
    if (r.webUrl) {
      const u = new URL(r.webUrl);
      if (u.protocol !== 'http:') throw new Error(`Receiver ${r.id}: webUrl must be http://… (the caster adds HTTPS in front of it)`);
      if (!cfg.webUi.domain) throw new Error('Set webUi.domain (e.g. "bases.example.com") to use receiver web UIs');
    }
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

export function findMountpoint(cfg, name) {
  return cfg.mountpoints.find(m => m.name === name) || null;
}
