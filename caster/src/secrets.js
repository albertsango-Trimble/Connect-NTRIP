// Rover passwords are checked against scrypt hashes. So that a login's details can be emailed to its operator,
// the password is also kept encrypted (AES-256-GCM) with a key that never leaves this server
// (<dataDir>/login-key, readable by the caster only). Logins whose password was set before this have none.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let key = null;

export function initSecrets(dataDir) {
  const f = path.join(dataDir, 'login-key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${f} is not a valid key`);
}

export function seal(text) {
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

/** The sealed text, or null if it is missing or wasn't sealed with this server's key. */
export function unseal(blob) {
  if (!key || typeof blob !== 'string') return null;
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
