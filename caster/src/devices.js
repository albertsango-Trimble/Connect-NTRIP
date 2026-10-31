// Rover accounts: username = receiver serial number, password chosen by the user.
// Passwords are stored as scrypt hashes, never in plain text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

export function normaliseSerial(serial) {
  return String(serial || '').trim().toUpperCase();
}

export function validateSerial(serial) {
  return /^[A-Z0-9\-_]{3,40}$/.test(serial);
}

// Company and operator details kept with each rover login.
export const PROFILE_FIELDS = {
  companyName: 'Company name',
  companyPhone: 'Company phone',
  companyEmail: 'Company email',
  operatorName: 'Operator name',
  operatorPhone: 'Operator phone',
  operatorEmail: 'Operator email',
};

function cleanProfile(input, existing = {}) {
  const out = { ...existing };
  if (!input || typeof input !== 'object') return out;
  for (const [key, label] of Object.entries(PROFILE_FIELDS)) {
    if (input[key] === undefined) continue;
    const v = String(input[key] ?? '').trim().slice(0, 120);
    if (v && key.endsWith('Email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new UserError(`${label} doesn't look like an email address`);
    if (v && key.endsWith('Phone') && !/^[0-9+()\-.\s]{4,30}$/.test(v)) throw new UserError(`${label} should be a phone number (digits, spaces, + - ( ) only)`);
    out[key] = v;
  }
  return out;
}

export function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 64 && /^[\x20-\x7E]+$/.test(pw);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

export class DeviceStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'devices.json');
    this.devices = {};
    if (fs.existsSync(this.file)) {
      this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')).devices || {};
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.entries(this.devices).map(([serial, d]) => publicView(serial, d));
  }

  get(serial) {
    const d = this.devices[normaliseSerial(serial)];
    return d ? publicView(normaliseSerial(serial), d) : null;
  }

  add({ serial, password, label = '', mountpoints = [], enabled = true, profile }) {
    serial = normaliseSerial(serial);
    if (!validateSerial(serial)) throw new UserError('Serial number must be 3-40 letters, digits, - or _');
    if (this.devices[serial]) throw new UserError(`Device ${serial} already exists`);
    if (!validatePassword(password)) throw new UserError('Password must be 6-64 printable characters');
    this.devices[serial] = {
      hash: hashPassword(password),
      label: String(label).slice(0, 80),
      mountpoints: Array.isArray(mountpoints) ? mountpoints.map(String) : [],
      enabled: !!enabled,
      profile: cleanProfile(profile),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    this.save();
    return this.get(serial);
  }

  update(serial, { password, label, mountpoints, enabled, profile }) {
    serial = normaliseSerial(serial);
    const d = this.devices[serial];
    if (!d) throw new UserError(`Device ${serial} not found`, 404);
    if (password !== undefined) {
      if (!validatePassword(password)) throw new UserError('Password must be 6-64 printable characters');
      d.hash = hashPassword(password);
    }
    if (label !== undefined) d.label = String(label).slice(0, 80);
    if (mountpoints !== undefined) d.mountpoints = Array.isArray(mountpoints) ? mountpoints.map(String) : [];
    if (enabled !== undefined) d.enabled = !!enabled;
    if (profile !== undefined) d.profile = cleanProfile(profile, d.profile);
    d.updated = new Date().toISOString();
    this.save();
    return this.get(serial);
  }

  remove(serial) {
    serial = normaliseSerial(serial);
    if (!this.devices[serial]) throw new UserError(`Device ${serial} not found`, 404);
    delete this.devices[serial];
    this.save();
  }

  /** Returns { ok, reason, device } for an NTRIP login attempt. */
  authenticate(serial, password, mountpoint) {
    serial = normaliseSerial(serial);
    const d = this.devices[serial];
    if (!d) return { ok: false, reason: 'unknown serial' };
    if (!checkPassword(password, d.hash)) return { ok: false, reason: 'bad password' };
    if (!d.enabled) return { ok: false, reason: 'device disabled' };
    if (d.mountpoints.length && !d.mountpoints.includes(mountpoint)) {
      return { ok: false, reason: `not allowed on ${mountpoint}` };
    }
    return { ok: true, device: publicView(serial, d) };
  }
}

function publicView(serial, d) {
  return { serial, label: d.label, mountpoints: d.mountpoints, enabled: d.enabled, profile: { ...emptyProfile(), ...(d.profile || {}) }, created: d.created, updated: d.updated };
}

function emptyProfile() {
  return Object.fromEntries(Object.keys(PROFILE_FIELDS).map(k => [k, '']));
}

export class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
