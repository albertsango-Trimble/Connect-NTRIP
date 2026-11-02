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
  // A mistake in one receiver entry is reported and that entry skipped; it never stops the caster starting
  const problem = r => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(r.id || '')) return `id "${r.id}" must be lower-case letters, digits and dashes`;
    if (ids.has(r.id)) return 'duplicate id';
    if (r.webUrl) {
      let u;
      try { u = new URL(r.webUrl); } catch { return `web address "${r.webUrl}" isn't a valid address`; }
      if (!/^https?:$/.test(u.protocol)) return 'web address must start with http:// or https://';
      if (!cfg.webUi.domain) return 'webUi.domain is not set, so receiver web pages cannot be served';
    }
    return null;
  };
  const good = [];
  for (const r of cfg.receivers) {
    const why = problem(r);
    if (why) { console.warn(`Skipping receiver ${r.id || '(no id)'} in the config: ${why}`); continue; }
    ids.add(r.id);
    r.mountpoints = (r.mountpoints || []).filter(mp => {
      if (names.has(mp)) return true;
      console.warn(`Receiver ${r.id}: mountpoint ${mp} isn't known yet; it is linked once a base sends to it`);
      return true; // kept: a base-named mountpoint may simply not have connected yet
    });
    good.push(r);
  }
  cfg.receivers = good;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

export function findMountpoint(cfg, name) {
  return cfg.mountpoints.find(m => m.name === name) || null;
}
