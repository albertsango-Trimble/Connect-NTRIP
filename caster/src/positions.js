// Base positions set by hand in the extension, for streams that don't carry one (e.g. CMRx).
// Kept in <dataDir>/base-positions.json, keyed by mountpoint name; works for configured and base-named mountpoints.
import fs from 'node:fs';
import path from 'node:path';

export class ManualPositions {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'base-positions.json');
    this.map = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')).positions || {} : {};
  }

  get(name) { return this.map[name] || null; }

  set(name, { lat, lon, h }, by) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw Object.assign(new Error('Latitude must be between -90 and 90'), { status: 400 });
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw Object.assign(new Error('Longitude must be between -180 and 180'), { status: 400 });
    let height = null;
    if (h !== undefined && h !== null && h !== '') {
      height = Number(h);
      if (!Number.isFinite(height) || height < -1000 || height > 10000) throw Object.assign(new Error('Height must be a number of metres'), { status: 400 });
    }
    this.map[name] = { lat: Number(lat.toFixed(9)), lon: Number(lon.toFixed(9)), h: height, by, at: new Date().toISOString() };
    this.save();
    return this.map[name];
  }

  clear(name) {
    if (!this.map[name]) return false;
    delete this.map[name];
    this.save();
    return true;
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ positions: this.map }, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
