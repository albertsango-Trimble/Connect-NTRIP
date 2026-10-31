import { loadConfig } from './config.js';
import { DeviceStore } from './devices.js';
import { CasterState } from './state.js';
import { startNtripServer } from './ntrip.js';
import { startDashboard } from './dashboard.js';

const config = loadConfig();
const devices = new DeviceStore(config.dataDir);
const state = new CasterState(config);

console.log(`${config.casterName}: ${config.mountpoints.length} mountpoint(s), ${devices.list().length} device(s)`);
if (!config.adminEmails.length && !config.dashboardToken) {
  console.warn('No adminEmails or dashboardToken configured: nobody will be able to open the dashboard.');
}

const ntrip = startNtripServer({ config, state, devices });
const dash = startDashboard({ config, state, devices });

function shutdown() {
  console.log('Shutting down');
  ntrip.close();
  dash.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
