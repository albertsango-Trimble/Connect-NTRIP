// Command-line helper to add or reset a rover login on the VM.
//   node tools/add-device.js <serial> <password> [label] [mount1,mount2]
// Run this while the caster is stopped (e.g. to create the first logins), then start it.
// While the caster is running, add devices from the extension's Devices tab instead.
import { loadConfig } from '../src/config.js';
import { DeviceStore } from '../src/devices.js';

const [serial, password, label = '', mounts = ''] = process.argv.slice(2);
if (!serial || !password) {
  console.error('Usage: node tools/add-device.js <serial> <password> [label] [mount1,mount2]');
  process.exit(1);
}
const config = loadConfig();
const store = new DeviceStore(config.dataDir);
const mountpoints = mounts ? mounts.split(',').map(s => s.trim()).filter(Boolean) : [];
try {
  const d = store.get(serial)
    ? store.update(serial, { password, label, mountpoints })
    : store.add({ serial, password, label, mountpoints });
  console.log(`Saved ${d.serial}${d.label ? ` (${d.label})` : ''} — mountpoints: ${d.mountpoints.length ? d.mountpoints.join(', ') : 'all'}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
