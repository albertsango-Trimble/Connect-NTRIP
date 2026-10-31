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
      this.event('source.replaced', { mount: src.mount, oldAddr: existing.addr });
      existing.close();
    }
    Object.assign(src, { connectedAt: Date.now(), bytesIn: 0, lastBytes: 0, rateBps: 0, lastDataAt: null });
    this.sources.set(src.mount, src);
    this.event('source.connected', { mount: src.mount, addr: src.addr, protocol: src.protocol });
  }

  removeSource(src, reason) {
    if (this.sources.get(src.mount) !== src) return;
    this.sources.delete(src.mount);
    this.event('source.disconnected', { mount: src.mount, addr: src.addr, reason });
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
    // One session per serial number: a reconnecting rover replaces its stale session.
    for (const other of this.clients.values()) {
      if (other.serial === client.serial) {
        this.event('rover.replaced', { serial: client.serial, oldAddr: other.addr });
        other.close();
      }
    }
    Object.assign(client, {
      connectedAt: Date.now(), bytesOut: 0, lastBytes: 0, rateBps: 0,
      gga: null, ggaAt: null, track: [],
    });
    this.clients.set(client.id, client);
    this.event('rover.connected', {
      id: client.id, serial: client.serial, label: client.label, mount: client.mount,
      addr: client.addr, protocol: client.protocol, agent: client.agent,
    });
  }

  removeClient(client, reason) {
    if (!this.clients.delete(client.id)) return;
    this.event('rover.disconnected', { id: client.id, serial: client.serial, mount: client.mount, reason });
  }

  updateGga(client, gga) {
    client.gga = gga;
    client.ggaAt = Date.now();
    if (gga.hasPosition) {
      const last = client.track[client.track.length - 1];
      if (!last || Math.abs(last[0] - gga.lat) > 1e-7 || Math.abs(last[1] - gga.lon) > 1e-7) {
        client.track.push([gga.lat, gga.lon, client.ggaAt, gga.quality]);
        if (client.track.length > TRACK_POINTS) client.track.shift();
      }
    }
    this.emit('position', client);
  }

  // ---- periodic ----
  tick() {
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

  // ---- views for the dashboard ----
  sourceView(m) {
    const s = this.sources.get(m.name);
    const station = s?.monitor?.station;
    return {
      name: m.name,
      identifier: m.identifier || '',
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
      position: station
        ? { lat: station.lat, lon: station.lon, h: station.h, stationId: station.stationId, antennaHeight: station.antennaHeight, from: 'RTCM 1005/1006' }
        : (m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon, h: m.h ?? null, from: 'config' } : null),
      rovers: [...this.clients.values()].filter(c => c.mount === m.name).length,
    };
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

  snapshot() {
    return {
      casterName: this.config.casterName || 'NTRIP Caster',
      host: this.config.publicHost || null,
      ntripPort: this.config.ntripPort,
      serverTime: Date.now(),
      startedAt: this.startedAt,
      mountpoints: this.config.mountpoints.map(m => this.sourceView(m)),
      rovers: [...this.clients.values()].map(c => this.clientView(c, true)),
      log: this.log.slice(-100),
    };
  }
}
