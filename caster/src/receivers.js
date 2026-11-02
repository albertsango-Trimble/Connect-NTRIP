// Base receivers whose own web interface can be opened from the extension.
// Two sources: the server config file (read-only here) and ones added from the extension, kept in
// <dataDir>/receivers.json (mode 600; receiver passwords are never sent back to the browser).
// config.receivers is kept as the merged, live list so the rest of the caster can read it directly.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UserError } from './devices.js';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class ReceiverStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.file = path.join(config.dataDir, 'receivers.json');
    this.fromConfig = config.receivers.map(r => ({ ...r, source: 'config' }));
    this.saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')).receivers || [] : [];
    this.sync();
  }

  sync() {
    const ids = new Set(this.fromConfig.map(r => r.id));
    const merged = [...this.fromConfig, ...this.saved.filter(r => !ids.has(r.id)).map(r => ({ ...r, source: 'extension' }))];
    this.config.receivers.splice(0, this.config.receivers.length, ...merged);
    this.emit('change');
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ receivers: this.saved }, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.sync();
  }

  get(id) { return this.config.receivers.find(r => r.id === id) || null; }

  /** Checks and tidies what the extension sent. `existing` is the receiver being edited. */
  clean(body, existing) {
    const out = {};
    const has = k => body[k] !== undefined;
    if (!existing || has('name')) {
      out.name = String(body.name ?? '').trim().slice(0, 60);
      if (!out.name) throw new UserError('Give the receiver a name');
    }
    if (has('model')) out.model = String(body.model ?? '').trim().slice(0, 60);
    if (!existing || has('webUrl')) {
      let url = String(body.webUrl ?? '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
      let u;
      try { u = new URL(url); } catch { throw new UserError('Web address should look like http://receiver.example.com:8080'); }
      if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new UserError('Web address should start with http:// or https://');
      if (/^(localhost|127\.|0\.|169\.254\.|\[?::1\]?$)/i.test(u.hostname)) throw new UserError('That address points at the caster server itself');
      out.webUrl = `${u.protocol}//${u.host}`;
    }
    if (has('mountpoints')) {
      const known = new Set(this.config.mountpoints.map(m => m.name));
      out.mountpoints = (Array.isArray(body.mountpoints) ? body.mountpoints : []).map(String).filter(n => known.has(n));
    }
    if (has('username')) out.username = String(body.username ?? '').trim().slice(0, 64);
    // Password: leave out to keep the saved one; an empty string clears it
    if (has('password')) out.password = String(body.password ?? '').slice(0, 128);
    return out;
  }

  add(body) {
    if (!this.config.webUi?.domain) throw new UserError('The server has no webUi.domain set, so it cannot serve receiver web pages yet');
    const r = { mountpoints: [], model: '', username: '', password: '', ...this.clean(body, null) };
    let base = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'base';
    if (!ID_RE.test(base)) base = 'base';
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`;
    r.id = id;
    r.created = new Date().toISOString();
    this.saved.push(r);
    this.save();
    return this.get(id);
  }

  update(id, body) {
    const r = this.saved.find(x => x.id === id);
    if (!r) {
      if (this.get(id)) throw new UserError('This receiver is set in the server config file, so it can only be changed there');
      throw new UserError('Receiver not found', 404);
    }
    Object.assign(r, this.clean(body, r), { updated: new Date().toISOString() });
    this.save();
    return this.get(id);
  }

  remove(id) {
    const i = this.saved.findIndex(x => x.id === id);
    if (i < 0) {
      if (this.get(id)) throw new UserError('This receiver is set in the server config file, so it can only be removed there');
      throw new UserError('Receiver not found', 404);
    }
    this.saved.splice(i, 1);
    this.save();
  }
}
