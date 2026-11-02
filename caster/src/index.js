import { loadConfig } from './config.js';
import { CasterState } from './state.js';
import { startNtripServer } from './ntrip.js';
import { startDashboard } from './dashboard.js';
import { Tokens, loadSecret, startWebUiProxy } from './webui.js';
import { ManualPositions } from './positions.js';
import { ReceiverStore } from './receivers.js';
import { Projects } from './projects.js';

const config = loadConfig();
const state = new CasterState(config);
state.positions = new ManualPositions(config.dataDir);
// Projects first: the receiver store and the NTRIP server look up which project things belong to
const projects = new Projects(config);
config.projects = projects;
state.projects = projects;
const receiverStore = new ReceiverStore(config);
config.receiverStore = receiverStore;

console.log(`${config.casterName}: ${config.mountpoints.length} mountpoint(s), ${projects.list().length} project(s)`);
if (!config.adminEmails.length) {
  console.warn('No adminEmails configured: the bases and logins from before projects stay unassigned until a caster operator opens the extension.');
}

const tokens = new Tokens(loadSecret(config));
const ntrip = startNtripServer({ config, state });
const dash = startDashboard({ config, state, tokens, receiverStore });
const webui = startWebUiProxy({ config, state, tokens, receiverStore });

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
