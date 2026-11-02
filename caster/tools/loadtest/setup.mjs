// 50 projects (p02..p50 plus "local-dev" so the extension can open one), 200 logins each
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const R = new URL('../../src/', import.meta.url).href;
const { initSecrets, seal } = await import(R + 'secrets.js');
const dataDir = process.argv[2];
initSecrets(dataDir);
const salt = crypto.randomBytes(16);
const hash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('pw123456', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
const ids = ['local-dev', ...Array.from({ length: 49 }, (_, i) => `p${String(i + 2).padStart(2, '0')}`)];
const projects = {};
const now = new Date().toISOString();
ids.forEach((id, i) => {
  projects[id] = { name: `Project ${i + 1}`, created: now, sourcePassword: `base-pw-${i + 1}` };
  const devices = {};
  for (let n = 0; n < 200; n++) {
    devices[`R${String(i + 1).padStart(2, '0')}${String(n).padStart(3, '0')}`] = { hash, sealed: seal('pw123456'), label: `Machine ${n + 1}`, mountpoints: [], enabled: true,
      profile: { companyName: ['Acme Civil', 'Downer', 'CivilCo'][n % 3], operatorName: `Operator ${n}` }, created: now, updated: now };
  }
  const d = path.join(dataDir, 'projects', id); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'devices.json'), JSON.stringify({ devices }));
});
fs.writeFileSync(path.join(dataDir, 'projects', 'projects.json'), JSON.stringify({ projects, legacyOwner: 'local-dev' }));
fs.writeFileSync(process.argv[3], JSON.stringify(ids.map((id, i) => ({ id, pw: `base-pw-${i + 1}`, mount: `BASE${String(i + 1).padStart(2, '0')}`, prefix: `R${String(i + 1).padStart(2, '0')}` }))));
console.log('projects', ids.length, 'logins', ids.length * 200);
