import { loadConfig } from './config.js';
import { DeviceStore } from './devices.js';
import { CasterState } from './state.js';
import { startNtripServer } from './ntrip.js';
import { startDashboard } from './dashboard.js';
import { Tokens, loadSecret, startWebUiProxy } from './webui.js';
import { History } from './history.js';

const config = loadConfig();
const devices = new DeviceStore(config.dataDir);
const state = new CasterState(config);
const history = new History(config.dataDir, config.historyDays);
state.history = history;

console.log(`${config.casterName}: ${config.mountpoints.length} mountpoint(s), ${devices.list().length} device(s)`);
if (!config.adminEmails.length && !config.dashboardToken) {
  console.warn('No adminEmails or dashboardToken configured: nobody will be able to open the dashboard.');
}

const tokens = new Tokens(loadSecret(config));
const ntrip = startNtripServer({ config, state, devices });
const dash = startDashboard({ config, state, devices, tokens, history });
const webui = startWebUiProxy({ config, state, tokens });

function shutdown() {
  console.log('Shutting down');
  // End live sessions cleanly so they are written to each rover's history
  for (const c of state.clients.values()) {
    c.endReason = 'caster restarted';
    c.close();
  }
  ntrip.close();
  dash.close();
  webui?.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
