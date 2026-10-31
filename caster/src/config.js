import fs from 'node:fs';
import path from 'node:path';

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
  cfg.mountpoints ??= [];

  const names = new Set();
  for (const m of cfg.mountpoints) {
    if (!/^[A-Za-z0-9_\-]{1,100}$/.test(m.name)) throw new Error(`Invalid mountpoint name: ${m.name}`);
    if (names.has(m.name)) throw new Error(`Duplicate mountpoint: ${m.name}`);
    if (!m.sourcePassword) throw new Error(`Mountpoint ${m.name} needs a sourcePassword`);
    names.add(m.name);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

export function findMountpoint(cfg, name) {
  return cfg.mountpoints.find(m => m.name === name) || null;
}
