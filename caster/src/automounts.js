// Mountpoints created by the bases themselves: a base that connects with the shared source password
// gets a mountpoint under whatever name it asked for. They are kept in <dataDir>/auto-mountpoints.json
// so rover logins and the history keep referring to them after a restart.
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9_\-]{1,100}$/;
const FROM_DATA = new Set(['RTCM 1005/1006', 'CMR Type 1']);

export class AutoMountpoints {
  constructor(config) {
    this.config = config;
    this.opts = { enabled: false, sourcePassword: '', ...(config.autoMountpoints || {}) };
    this.file = path.join(config.dataDir, 'auto-mountpoints.json');
    if (this.enabled && !this.opts.sourcePassword) throw new Error('autoMountpoints.sourcePassword must be set when autoMountpoints is enabled');
    // Bring back the ones created before, after the configured ones
    if (fs.existsSync(this.file)) {
      for (const rec of JSON.parse(fs.readFileSync(this.file, 'utf8')).mountpoints || []) {
        if (!NAME_RE.test(rec.name) || config.mountpoints.some(m => m.name === rec.name)) continue;
        config.mountpoints.push(this.toMountpoint(rec));
      }
    }
  }

  get enabled() { return !!this.opts.enabled; }

  toMountpoint(rec) {
    return {
      name: rec.name,
      identifier: rec.identifier || rec.name,
      format: rec.format || 'Detecting…',
      formatDetails: rec.formatDetails || '',
      carrier: 2,
      navSystem: rec.navSystem || '',
      auto: true,
      created: rec.created,
      lastSeen: rec.lastSeen,
      lat: rec.lat ?? null,
      lon: rec.lon ?? null,
      h: rec.h ?? null,
      positionFrom: rec.positionFrom || null,
    };
  }

  save() {
    const list = this.config.mountpoints.filter(m => m.auto).map(m => ({
      name: m.name, identifier: m.identifier, format: m.format, formatDetails: m.formatDetails, navSystem: m.navSystem,
      created: m.created, lastSeen: m.lastSeen, lat: m.lat, lon: m.lon, h: m.h, positionFrom: m.positionFrom,
    }));
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ mountpoints: list }, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /**
   * Called for a base asking for a mountpoint that isn't configured. Returns the mountpoint
   * (creating it if needed) when the shared password is right, otherwise null.
   */
  claim(name, password, strHeader) {
    if (!this.enabled || password !== this.opts.sourcePassword || !NAME_RE.test(name)) return null;
    let m = this.config.mountpoints.find(x => x.name === name);
    if (m && !m.auto) return null; // configured mountpoints keep their own passwords
    if (!m) {
      m = this.toMountpoint({ name, created: new Date().toISOString() });
      this.config.mountpoints.push(m);
    }
    // NTRIP 2 bases can describe themselves with an Ntrip-STR header: STR;mount;identifier;format;details;carrier;nav;network;country;lat;lon;...
    const str = parseStr(strHeader);
    if (str) {
      if (str.identifier) m.identifier = str.identifier;
      if (str.navSystem) m.navSystem = str.navSystem;
      if (str.lat != null && str.lon != null && !FROM_DATA.has(m.positionFrom)) {
        m.lat = str.lat; m.lon = str.lon; m.positionFrom = 'base (Ntrip-STR)';
      }
    }
    m.lastSeen = new Date().toISOString();
    this.save();
    return m;
  }

  /** Remembers what was learned while the base was connected. */
  update(m, { format, station, fallback }) {
    if (!m?.auto) return;
    let changed = false;
    if (format && m.format !== format) { m.format = format; changed = true; }
    if (station) {
      m.lat = station.lat; m.lon = station.lon; m.h = station.h; m.positionFrom = station.from; changed = true;
    } else if (fallback && !FROM_DATA.has(m.positionFrom) && m.positionFrom !== 'base (Ntrip-STR)') {
      m.lat = fallback.lat; m.lon = fallback.lon; m.h = fallback.h ?? null; m.positionFrom = fallback.from; changed = true;
    }
    m.lastSeen = new Date().toISOString();
    if (changed || m.auto) this.save();
  }

  remove(name) {
    const i = this.config.mountpoints.findIndex(m => m.name === name && m.auto);
    if (i < 0) return false;
    this.config.mountpoints.splice(i, 1);
    this.save();
    return true;
  }
}

function parseStr(header) {
  if (!header) return null;
  const f = String(header).split(';');
  if (f[0] !== 'STR') return null;
  const lat = parseFloat(f[9]), lon = parseFloat(f[10]);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return { identifier: f[2] || '', navSystem: f[6] || '', lat: ok ? lat : null, lon: ok ? lon : null };
}
