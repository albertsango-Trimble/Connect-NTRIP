// Online history per rover login: one JSON-lines file per serial number in <dataDir>/history.
// Each line is a finished session ({ type: 'session', ... }) or a refused login ({ type: 'rejected', ... }).
// History is kept for good: nothing is ever removed from these files.
// Each session's trail is kept next to it in <dataDir>/tracks/<serial>/<session start ms>.jsonl, one point
// per line: [lat, lon, time ms, GGA fix quality]. When the session ends the file is gzipped (.jsonl.gz, about
// a quarter of the size).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// Compress a few trails at a time, so thousands of machines disconnecting together don't swamp the server
const queue = [];
let running = 0;
function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift();
    running++;
    Promise.resolve().then(job).catch(() => {}).finally(() => { running--; pump(); });
  }
}
function enqueue(job) {
  queue.push(job);
  pump();
}

export class History {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'history');
    this.tracksDir = path.join(dataDir, 'tracks');
    fs.mkdirSync(this.dir, { recursive: true });
    // Trails left uncompressed (e.g. the caster stopped mid-way): compress ones untouched for 10 minutes
    setTimeout(() => this.sweep(), 60_000).unref();
  }

  /** Works through the trail folders a little at a time, so it never holds up the corrections. */
  async sweep() {
    const old = Date.now() - 10 * 60_000;
    let serials = [];
    try { serials = await fs.promises.readdir(this.tracksDir); } catch { return; }
    for (const serial of serials) {
      const dir = path.join(this.tracksDir, serial);
      let names = [];
      try { names = await fs.promises.readdir(dir); } catch { continue; }
      for (const n of names) {
        const f = path.join(dir, n);
        try {
          if (n.endsWith('.gz.tmp')) await fs.promises.unlink(f);
          const m = n.match(/^(\d+)\.jsonl$/);
          if (m && (await fs.promises.stat(f)).mtimeMs < old) this.compressTrack(serial, Number(m[1]));
        } catch { /* ignore */ }
      }
      // let the compressions catch up before queueing more
      while (queue.length > 50) await new Promise(r => setTimeout(r, 200));
    }
  }

  trackFile(serial, start) {
    this.file(serial); // checks the serial
    if (!Number.isSafeInteger(Number(start))) throw new Error(`bad session start ${start}`);
    return path.join(this.tracksDir, serial, `${Number(start)}.jsonl`);
  }

  /**
   * Adds points to a session's trail. Written in the background so thousands of machines saving their trails
   * never hold up the corrections; writes to one file stay in order. Resolves when written.
   */
  appendTrack(serial, start, points) {
    if (!points.length) return Promise.resolve();
    let f;
    try { f = this.trackFile(serial, start); } catch (err) { return Promise.resolve(); }
    const text = points.map(p => JSON.stringify(p)).join('\n') + '\n';
    this.pending ??= new Map();
    const prev = this.pending.get(f) || Promise.resolve();
    const next = prev
      .then(() => fs.promises.mkdir(path.dirname(f), { recursive: true }))
      .then(() => fs.promises.appendFile(f, text, { mode: 0o600 }))
      .catch(err => console.error(`Could not write the trail for ${serial}: ${err.message}`))
      .finally(() => { if (this.pending.get(f) === next) this.pending.delete(f); });
    this.pending.set(f, next);
    return next;
  }

  /** Waits for trail writes still in progress for this file (so a read sees every point). */
  async settled(serial, start) {
    try { await this.pending?.get(this.trackFile(serial, start)); } catch { /* ignore */ }
  }

  /** Gzips a finished session's trail once its last points are written. */
  compressTrack(serial, start) {
    let f;
    try { f = this.trackFile(serial, start); } catch { return; }
    enqueue(() => this.settled(serial, start)
      .then(async () => {
        if (!fs.existsSync(f)) return;
        await pipeline(fs.createReadStream(f), zlib.createGzip({ level: 6 }), fs.createWriteStream(f + '.gz.tmp', { mode: 0o600 }));
        await fs.promises.rename(f + '.gz.tmp', f + '.gz');
        await fs.promises.unlink(f);
      })
      .catch(err => console.error(`Could not compress the trail for ${serial}: ${err.message}`)));
  }

  /** The trail of one session ([lat, lon, time, quality] points), or [] if none was kept. */
  readTrack(serial, start) {
    const f = this.trackFile(serial, start);
    let text = '';
    // A plain file means the session is live or still being compressed; either way it has every point
    if (fs.existsSync(f)) text = fs.readFileSync(f, 'utf8');
    else if (fs.existsSync(f + '.gz')) text = zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8');
    else return [];
    const out = [];
    for (const line of text.split('\n')) {
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
