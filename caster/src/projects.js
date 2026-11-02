// Trimble Connect projects on this caster. Each project has its own base password: a base that connects with
// it (under any mountpoint name) belongs to that project, and so do that mountpoint's rovers, logins, history,
// base receivers and log. Data from before projects existed goes to the first project that opens the extension.
//
// <dataDir>/projects/projects.json             the list of projects and their base passwords
// <dataDir>/projects/<id>/devices.json         that project's rover logins
// <dataDir>/projects/<id>/history/*.jsonl      that project's rover online history
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DeviceStore, UserError } from './devices.js';
import { History } from './history.js';

const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function generatePassword() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map(b => PW_CHARS[b % PW_CHARS.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export class Projects {
  constructor(config) {
    this.config = config;
    this.dir = path.join(config.dataDir, 'projects');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'projects.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { projects: {}, legacyOwner: null };
    this.data.projects ??= {};
    this.stores = new Map(); // id -> { devices, history }
    // Data kept from before projects, used until a project takes it over
    this.legacy = { devices: new DeviceStore(config.dataDir), history: new History(config.dataDir, config.historyDays) };
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  get legacyOwner() { return this.data.legacyOwner || null; }
  get(id) { return id && this.data.projects[id] ? { id, ...this.data.projects[id] } : null; }
  list() { return Object.keys(this.data.projects).map(id => this.get(id)); }

  /** The project a mountpoint or receiver belongs to (ones from before projects belong to the first project). */
  projectOf(item) { return item?.project || this.legacyOwner; }

  /** The project whose base password this is, if any. */
  byPassword(password) {
    if (!password) return null;
    for (const [id, p] of Object.entries(this.data.projects)) if (p.sourcePassword === password) return id;
    return null;
  }

  /** Base password a mountpoint's base must use. */
  passwordFor(projectId) {
    return projectId ? this.data.projects[projectId]?.sourcePassword : this.config.autoMounts?.opts.sourcePassword;
  }

  uniquePassword() {
    let pw;
    do pw = generatePassword(); while (this.byPassword(pw));
    return pw;
  }

  /**
   * Called whenever the extension is opened in a project: registers it the first time (with its own base
   * password) and keeps its name up to date. The first project a caster operator opens also takes over everything
   * from before projects existed, and keeps the base password from the config file so those bases carry on unchanged.
   */
  open(id, name, { canClaimLegacy = true } = {}) {
    if (!ID_RE.test(id || '')) throw new UserError('Unknown project');
    let p = this.data.projects[id];
    let claimed = false;
    if (!p) {
      p = { name: String(name || '').slice(0, 120), created: new Date().toISOString() };
      if (!this.legacyOwner && canClaimLegacy) {
        p.sourcePassword = this.config.autoMounts?.opts.sourcePassword || generatePassword();
        this.data.legacyOwner = id;
        this.data.projects[id] = p;
        this.takeOverLegacy(id);
        claimed = true;
      } else {
        p.sourcePassword = this.uniquePassword();
        this.data.projects[id] = p;
      }
      this.save();
    } else if (name && p.name !== name) {
      p.name = String(name).slice(0, 120);
      this.save();
    }
    return { project: this.get(id), claimedLegacy: claimed };
  }

  /** Moves logins, history, base-named mountpoints and receivers from before projects into this project. */
  takeOverLegacy(id) {
    const dest = this.projectDir(id);
    const legacyDevices = path.join(this.config.dataDir, 'devices.json');
    if (fs.existsSync(legacyDevices)) fs.renameSync(legacyDevices, path.join(dest, 'devices.json'));
    const legacyHistory = path.join(this.config.dataDir, 'history');
    if (fs.existsSync(legacyHistory)) {
      fs.mkdirSync(path.join(dest, 'history'), { recursive: true });
      for (const f of fs.readdirSync(legacyHistory)) fs.renameSync(path.join(legacyHistory, f), path.join(dest, 'history', f));
    }
    for (const m of this.config.mountpoints) if (m.auto && !m.project) m.project = id;
    this.config.autoMounts?.save();
    this.config.receiverStore?.adopt(id);
    this.legacy = { devices: new DeviceStore(this.config.dataDir), history: this.legacy.history };
    this.stores.delete(id);
  }

  projectDir(id) {
    const d = path.join(this.dir, id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  storesFor(id) {
    if (!id) return this.legacy;
    let s = this.stores.get(id);
    if (!s) {
      const d = this.projectDir(id);
      s = { devices: new DeviceStore(d), history: new History(d, this.config.historyDays) };
      this.stores.set(id, s);
    }
    return s;
  }

  devicesFor(id) { return this.storesFor(id).devices; }
  historyFor(id) { return this.storesFor(id).history; }

  /** Gives the project a new base password; bases using the old one must be updated. */
  newPassword(id) {
    const p = this.data.projects[id];
    if (!p) throw new UserError('Unknown project', 404);
    p.sourcePassword = this.uniquePassword();
    this.save();
    return p.sourcePassword;
  }
}
