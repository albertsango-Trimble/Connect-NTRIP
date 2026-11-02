// Live registry of connected bases (sources) and rovers (clients).
import { EventEmitter } from 'node:events';

const TRACK_POINTS = 300;
const LOG_SIZE = 300;

export class CasterState extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sources = new Map(); // mount -> source
    this.clients = new Map(); // id -> client
    this.log = [];
    this.nextId = 1;
    this.startedAt = Date.now();
    this.tickCount = 0;
    this.receiverStatus = new Map(); // receiver id -> { reachable, httpStatus, error, checkedAt }
    this.ticker = setInterval(() => this.tick(), 1000);
    this.ticker.unref();
  }

  newId() { return `c${this.nextId++}`; }

  event(type, data = {}) {
    const ev = { type, time: new Date().toISOString(), ...data };
    this.log.push(ev);
    if (this.log.length > LOG_SIZE) this.log.shift();
    const extra = Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    console.log(`[${ev.time}] ${type} ${extra}`);
    this.emit('event', ev);
  }

  // ---- sources ----
  addSource(src) {
    const existing = this.sources.get(src.mount);
    if (existing) {
      this.event('source.replaced', { project: src.project, mount: src.mount, oldAddr: existing.addr });
      existing.close();
    }
    Object.assign(src, { connectedAt: Date.now(), bytesIn: 0, lastBytes: 0, rateBps: 0, lastDataAt: null });
    this.sources.set(src.mount, src);
    this.event('source.connected', { project: src.project, mount: src.mount, addr: src.addr, protocol: src.protocol });
  }

  removeSource(src, reason) {
    if (this.sources.get(src.mount) !== src) return;
    this.sources.delete(src.mount);
    this.event('source.disconnected', { project: src.project, mount: src.mount, addr: src.addr, reason });
  }

  relay(src, data) {
    src.bytesIn += data.length;
    src.lastDataAt = Date.now();
    if (src.monitor) src.monitor.push(data);
    for (const c of this.clients.values()) {
      if (c.mount === src.mount) c.send(data);
    }
  }

  // ---- clients ----
  addClient(client) {
    // One session per serial number in a project: a reconnecting rover replaces its stale session.
    for (const other of this.clients.values()) {
      if (other.serial === client.serial && other.project === client.project) {
        this.event('rover.replaced', { project: client.project, serial: client.serial, oldAddr: other.addr });
        other.endReason = 'replaced by a new connection from the same receiver';
        other.close();
      }
    }
    Object.assign(client, {
      connectedAt: Date.now(), bytesOut: 0, lastBytes: 0, rateBps: 0,
      gga: null, ggaAt: null, track: [], fixMs: {}, firstPos: null,
    });
    this.clients.set(client.id, client);
    this.event('rover.connected', {
      project: client.project, id: client.id, serial: client.serial, label: client.label, mount: client.mount,
      addr: client.addr, protocol: client.protocol, agent: client.agent,
    });
  }

  removeClient(client, reason) {
    if (!this.clients.delete(client.id)) return;
    reason = client.endReason || reason;
    this.event('rover.disconnected', { project: client.project, id: client.id, serial: client.serial, mount: client.mount, reason });
    this.projects?.historyFor(client.project).append(client.serial, this.sessionRecord(client, reason));
  }

  /** Adds the time since the last GGA to the fix type it reported (gaps over 30 s count as no position). */
  accountFix(client, now) {
    if (!client.ggaAt) return;
    const dt = now - client.ggaAt;
    const q = client.gga?.hasPosition ? client.gga.quality : 0;
    const counted = Math.min(dt, 30_000);
    client.fixMs[q] = (client.fixMs[q] || 0) + counted;
    if (dt > counted) client.fixMs.gap = (client.fixMs.gap || 0) + (dt - counted);
  }

  /** What is kept in the rover's online history when a session ends. */
  sessionRecord(client, reason) {
    const end = Date.now();
    this.accountFix(client, end);
    const f = client.fixMs;
    const sec = ms => Math.round((ms || 0) / 1000);
    const other = Object.entries(f).filter(([k]) => !['0', '4', '5', 'gap'].includes(k)).reduce((a, [, v]) => a + v, 0);
    const last = client.gga?.hasPosition ? client.gga : null;
    return {
      type: 'session',
      start: client.connectedAt,
      end,
      durationSec: sec(end - client.connectedAt),
      mount: client.mount,
      label: client.label,
      protocol: client.protocol,
      addr: client.addr,
      agent: client.agent,
      bytes: client.bytesOut,
      endReason: reason,
      sentPosition: !!client.ggaAt,
      fixSec: { fixed: sec(f[4]), float: sec(f[5]), other: sec(other), none: sec((f[0] || 0) + (f.gap || 0)) },
      firstPos: client.firstPos,
      lastPos: last ? [Number(last.lat.toFixed(7)), Number(last.lon.toFixed(7))] : null,
    };
  }

  /** A refused login for a known rover, kept in its history. */
  recordRejected(project, serial, data) {
    this.projects?.historyFor(project).append(serial, { type: 'rejected', time: Date.now(), ...data });
  }

  updateGga(client, gga) {
    const now = Date.now();
    this.accountFix(client, now);
    client.gga = gga;
    client.ggaAt = now;
    if (gga.hasPosition && !client.firstPos) client.firstPos = [Number(gga.lat.toFixed(7)), Number(gga.lon.toFixed(7))];
    if (gga.hasPosition) {
      const last = client.track[client.track.length - 1];
      if (!last || Math.abs(last[0] - gga.lat) > 1e-7 || Math.abs(last[1] - gga.lon) > 1e-7) {
        client.track.push([gga.lat, gga.lon, client.ggaAt, gga.quality]);
        if (client.track.length > TRACK_POINTS) client.track.shift();
      }
    }
    this.emit('position', client);
  }

  // ---- base receivers ----
  setReceiverStatus(id, status) {
    const prev = this.receiverStatus.get(id);
    this.receiverStatus.set(id, { ...status, checkedAt: Date.now() });
    if (prev && prev.reachable !== status.reachable) {
      const project = this.projects?.projectOf(this.config.receivers.find(r => r.id === id));
      this.event(status.reachable ? 'receiver.reachable' : 'receiver.unreachable', { project, receiver: id, ...(status.error ? { reason: status.error } : {}) });
    }
  }

  receiverViews(project) {
    return this.config.receivers.filter(r => this.projects?.projectOf(r) === project).map(r => ({
      id: r.id,
      name: r.name || r.id,
      model: r.model || '',
      mountpoints: r.mountpoints || [],
      webUi: !!r.webUrl,
      // Shown to admins in the extension; the receiver password is never sent
      webUrl: r.webUrl || '',
      username: r.username || '',
      hasPassword: !!r.password,
      source: r.source || 'config',
      ...(this.receiverStatus.get(r.id) || { reachable: null }),
    }));
  }

  // ---- periodic ----
  tick() {
    // Base-named mountpoints: note their format and position every 10 s, even with no dashboard open
    if (++this.tickCount % 10 === 0) {
      for (const m of this.config.mountpoints) if (m.auto && this.sources.has(m.name)) this.sourceView(m);
    }
    for (const s of this.sources.values()) {
      s.rateBps = s.bytesIn - s.lastBytes;
      s.lastBytes = s.bytesIn;
    }
    for (const c of this.clients.values()) {
      c.rateBps = c.bytesOut - c.lastBytes;
      c.lastBytes = c.bytesOut;
    }
    this.emit('tick');
  }

  /**
   * A position for a stream that doesn't carry one (CMR+/CMRx): taken from another stream the same
   * base is sending right now (same address), which usually carries RTCM 1005/1006 or CMR Type 1.
   */
  sitePosition(src) {
    const host = src.addr?.replace(/:\d+$/, '');
    for (const other of this.sources.values()) {
      if (other === src || other.addr?.replace(/:\d+$/, '') !== host) continue;
      const st = other.monitor?.station;
      if (st) return { lat: st.lat, lon: st.lon, h: st.h, from: `same base as ${other.mount}` };
    }
    return null;
  }

  // ---- views for the dashboard ----
  sourceView(m) {
    const s = this.sources.get(m.name);
    const station = s?.monitor?.station;
    const site = !station && s ? this.sitePosition(s) : null;
    const detected = s?.monitor?.detected?.() || null;
    if (m.auto) {
      // Remember what was learned while the base is sending, so it is still known after it disconnects
      let changed = false;
      if (detected && m.format !== detected) { m.format = detected; changed = true; }
      const live = station ? { lat: station.lat, lon: station.lon, h: station.h, from: station.from } : site;
      if (live && (m.lat == null || Math.abs(m.lat - live.lat) > 1e-6 || Math.abs(m.lon - live.lon) > 1e-6 || m.positionFrom !== live.from)) {
        m.lat = live.lat; m.lon = live.lon; m.h = live.h ?? null; m.positionFrom = live.from; changed = true;
      }
      if (changed) this.config.autoMounts?.save();
    }
    return {
      name: m.name,
      identifier: m.identifier || '',
      auto: !!m.auto,
      detectedFormat: detected,
      lastSeen: m.lastSeen || null,
      format: m.format,
      navSystem: m.navSystem || '',
      online: !!s,
      addr: s?.addr || null,
      protocol: s?.protocol || null,
      connectedAt: s?.connectedAt || null,
      lastDataAt: s?.lastDataAt || null,
      bytesIn: s?.bytesIn || 0,
      rateBps: s?.rateBps || 0,
      messageTypes: s?.monitor ? s.monitor.messageTypes() : [],
      position: this.position(m, station, site),
      manualPosition: this.positions?.get(m.name) || null,
      rovers: [...this.clients.values()].filter(c => c.mount === m.name).length,
    };
  }

  /**
   * Where the base is, best source first: the base's own data (RTCM 1005/1006, CMR Type 1), another stream
   * the same base is sending now, a position set by hand in the extension, then what was last known or configured.
   */
  position(m, station, site) {
    if (station === undefined) {
      const s = this.sources.get(m.name);
      station = s?.monitor?.station;
      site = !station && s ? this.sitePosition(s) : null;
    }
    if (station) return { lat: station.lat, lon: station.lon, h: station.h, stationId: station.stationId, antennaHeight: station.antennaHeight, accuracy: station.accuracy, from: station.from };
    if (site) return { lat: site.lat, lon: site.lon, h: site.h ?? null, from: site.from };
    const manual = this.positions?.get(m.name);
    if (manual) return { lat: manual.lat, lon: manual.lon, h: manual.h, from: 'set by hand', by: manual.by, at: manual.at };
    if (m.lat != null && m.lon != null) return { lat: m.lat, lon: m.lon, h: m.h ?? null, from: m.auto ? `${m.positionFrom || 'last known'}` : 'config' };
    return null;
  }

  clientView(c, withTrack = false) {
    return {
      id: c.id,
      serial: c.serial,
      label: c.label,
      mount: c.mount,
      addr: c.addr,
      protocol: c.protocol,
      agent: c.agent,
      connectedAt: c.connectedAt,
      bytesOut: c.bytesOut,
      rateBps: c.rateBps,
      gga: c.gga,
      ggaAt: c.ggaAt,
      ...(withTrack ? { track: c.track } : {}),
    };
  }

  /** Mountpoints, machines, receivers and log of one project. */
  mountpointViews(project) {
    return this.config.mountpoints.filter(m => this.projects?.projectOf(m) === project).map(m => this.sourceView(m));
  }

  roverViews(project, withTrack = false) {
    return [...this.clients.values()].filter(c => c.project === project).map(c => this.clientView(c, withTrack));
  }

  snapshot(project) {
    return {
      casterName: this.config.casterName || 'NTRIP Caster',
      host: this.config.publicHost || null,
      ntripPort: this.config.ntripPort,
      serverTime: Date.now(),
      startedAt: this.startedAt,
      mountpoints: this.mountpointViews(project),
      rovers: this.roverViews(project, true),
      receivers: this.receiverViews(project),
      log: this.log.filter(ev => ev.project === project).slice(-100),
    };
  }
}
