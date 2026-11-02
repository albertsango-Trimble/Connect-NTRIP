// Online history per rover login: one JSON-lines file per serial number in <dataDir>/history.
// Each line is a finished session ({ type: 'session', ... }) or a refused login ({ type: 'rejected', ... }).
// History is kept for good: nothing is ever removed from these files.
// Each session's trail is kept next to it in <dataDir>/tracks/<serial>/<session start ms>.jsonl, one point
// per line: [lat, lon, time ms, GGA fix quality].
import fs from 'node:fs';
import path from 'node:path';

export class History {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'history');
    this.tracksDir = path.join(dataDir, 'tracks');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  trackFile(serial, start) {
    this.file(serial); // checks the serial
    if (!Number.isSafeInteger(Number(start))) throw new Error(`bad session start ${start}`);
    return path.join(this.tracksDir, serial, `${Number(start)}.jsonl`);
  }

  appendTrack(serial, start, points) {
    if (!points.length) return;
    try {
      const f = this.trackFile(serial, start);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, points.map(p => JSON.stringify(p)).join('\n') + '\n', { mode: 0o600 });
    } catch (err) {
      console.error(`Could not write the trail for ${serial}: ${err.message}`);
    }
  }

  /** The trail of one session ([lat, lon, time, quality] points), or [] if none was kept. */
  readTrack(serial, start) {
    const f = this.trackFile(serial, start);
    if (!fs.existsSync(f)) return [];
    const out = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
    }
    return out;
  }

  file(serial) {
    // serials are validated as [A-Z0-9-_], so they are safe as file names
    if (!/^[A-Z0-9\-_]{1,40}$/.test(serial)) throw new Error(`bad serial ${serial}`);
    return path.join(this.dir, `${serial}.jsonl`);
  }

  append(serial, record) {
    try {
      fs.appendFileSync(this.file(serial), JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error(`Could not write history for ${serial}: ${err.message}`);
    }
  }

  /** Records for one serial, newest first, optionally only since `fromMs`. */
  read(serial, { fromMs = 0, limit = 5000 } = {}) {
    const f = this.file(serial);
    if (!fs.existsSync(f)) return [];
    const out = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if ((r.end ?? r.time ?? 0) >= fromMs) out.push(r);
      } catch { /* skip a damaged line */ }
    }
    out.sort((a, b) => (b.start ?? b.time) - (a.start ?? a.time));
    return out.slice(0, limit);
  }

}
