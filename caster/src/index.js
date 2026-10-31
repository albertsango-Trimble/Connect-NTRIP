import { loadConfig } from './config.js';
import { DeviceStore } from './devices.js';
import { CasterState } from './state.js';
import { startNtripServer } from './ntrip.js';
import { startDashboard } from './dashboard.js';
import { Tokens, loadSecret, startWebUiProxy } from './webui.js';

const config = loadConfig();
const devices = new DeviceStore(config.dataDir);
const state = new CasterState(config);

console.log(`${config.casterName}: ${config.mountpoints.length} mountpoint(s), ${devices.list().length} device(s)`);
if (!config.adminEmails.length && !config.dashboardToken) {
  console.warn('No adminEmails or dashboardToken configured: nobody will be able to open the dashboard.');
}

const tokens = new Tokens(loadSecret(config));
const ntrip = startNtripServer({ config, state, devices });
const dash = startDashboard({ config, state, devices, tokens });
const webui = startWebUiProxy({ config, state, tokens });

function shutdown() {
  console.log('Shutting down');
  ntrip.close();
  dash.close();
  webui?.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
