// Online history per rover login: one JSON-lines file per serial number in <dataDir>/history.
// Each line is a finished session ({ type: 'session', ... }) or a refused login ({ type: 'rejected', ... }).
// History is kept for good: nothing is ever removed from these files.
import fs from 'node:fs';
import path from 'node:path';

export class History {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'history');
    fs.mkdirSync(this.dir, { recursive: true });
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
