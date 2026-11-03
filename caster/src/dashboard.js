// HTTPS-facing (via reverse proxy) API + WebSocket feed for the Trimble Connect extension.
//
// Auth: the extension sends its Trimble Connect access token and the Connect project it is open in.
// The caster checks the token against the Trimble Connect API (/users/me) and that the user can open that
// project. Everything the extension sees and changes (bases, machines, logins, receivers, history, log) is
// limited to that project. Project admins (role ADMIN in the project team, or anyone in config.adminEmails)
// can manage everything; other project members get a view-only map of bases and machines.
// A static dashboardToken can also be set for local development.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { UserError, normaliseSerial } from './devices.js';
import { isReceiverHost, startLink } from './webui.js';
import { compose, emailEnabled, sendEmail } from './credentials.js';
import fs from 'node:fs';
import { buildMonth, listReports, markUploaded, monthOf, monthRange, previousMonth, reportFile } from './reports.js';

const AUTH_CACHE_MS = 5 * 60 * 1000;
const EXPORT_FORMAT = 'connect-ntrip-logins';

export function startDashboard({ config, state, tokens, receiverStore }) {
  const projects = config.projects;
  const authCache = new Map(); // sha256(token) -> { user, expires }
  const projectCache = new Map(); // sha256(token + project) -> expires
  const adminCache = new Map(); // sha256(token + project) -> { admin, expires }

  const hash = s => crypto.createHash('sha256').update(s).digest('hex');

  async function authenticate(token) {
    if (!token) return null;
    if (config.dashboardToken && safeEqual(token, config.dashboardToken)) {
      return { email: 'dashboard-token', name: 'Dashboard token', dev: true };
    }
    const key = hash(token);
    const cached = authCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.user;

    let user = null;
    for (const base of config.tcApiHosts) {
      try {
        const res = await fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const me = await res.json();
          const email = String(me.email || '').toLowerCase();
          if (email) user = { email, id: me.id || null, name: [me.firstName, me.lastName].filter(Boolean).join(' ') || email, operator: config.adminEmails.includes(email) };
          else console.warn('Dashboard login refused: Trimble Connect returned no email for this token');
          break;
        }
      } catch (err) {
        console.warn(`Token check against ${base} failed: ${err.message}`);
      }
    }
    if (user) authCache.set(key, { user, expires: Date.now() + AUTH_CACHE_MS });
    return user;
  }

  /** True when this user can open the Connect project (checked with Connect, using their own token). */
  async function canOpenProject(token, user, projectId) {
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(projectId || '')) return false;
    if (user.dev) return true;
    const key = hash(`${token}|${projectId}`);
    if ((projectCache.get(key) || 0) > Date.now()) return true;
    for (const base of config.tcApiHosts) {
      try {
        const res = await fetch(`${base}/projects/${encodeURIComponent(projectId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          projectCache.set(key, Date.now() + AUTH_CACHE_MS);
          return true;
        }
      } catch {
        /* try the next region */
      }
    }
    return false;
  }

  /**
   * True when the user is an administrator of the Connect project (role ADMIN in the project's team).
   * Anything that can't be confirmed counts as not an admin.
   */
  async function isProjectAdmin(token, user, projectId) {
    if (user.dev || user.operator) return true; // caster operators (adminEmails) manage every project
    const key = hash(`${token}|admin|${projectId}`);
    const cached = adminCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.admin;
    let admin = null;
    for (const base of config.tcApiHosts) {
      try {
        const res = await fetch(`${base}/projects/${encodeURIComponent(projectId)}/users`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const body = await res.json();
        const list = Array.isArray(body) ? body : body.items || body.users || [];
        const me = list.find(u => (user.id && u.id === user.id) || String(u.email || '').toLowerCase() === user.email);
        admin = String(me?.role || '').toUpperCase() === 'ADMIN';
        break;
      } catch {
        /* try the next region */
      }
    }
    if (admin === null) {
      console.warn(`Could not read the team of project ${projectId} to check whether ${user.email} is an admin`);
      return false; // not cached, so it is tried again next time
    }
    adminCache.set(key, { admin, expires: Date.now() + AUTH_CACHE_MS });
    return admin;
  }

  /** Signs in and opens the project; throws a 401/403 error when not allowed. */
  async function access(token, projectId, projectName) {
    const user = await authenticate(token);
    if (!user) throw new UserError('Not authorised', 401);
    if (!projectId) throw new UserError('Open the extension inside a Trimble Connect project', 400);
    if (!(await canOpenProject(token, user, projectId))) throw new UserError('You do not have access to this project', 403);
    const admin = await isProjectAdmin(token, user, projectId);
    // Only a caster operator can take over the bases and logins from before projects existed
    const { project, claimedLegacy } = projects.open(projectId, projectName, { canClaimLegacy: !!(user.dev || user.operator) });
    if (claimedLegacy) state.event('project.took_over_existing', { project: projectId, by: user.email });
    return { user: { ...user, projectAdmin: admin }, project, admin };
  }

  /** The base password and connection details are only given to the project's admins. */
  function projectInfo(p, admin) {
    return {
      id: p.id,
      name: p.name,
      isAdmin: !!admin,
      emailEnabled: !!admin && emailEnabled(config),
      baseConnection: admin ? { host: config.publicHost || null, port: config.ntripPort, password: p.sourcePassword } : null,
    };
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Connect-Project, X-Connect-Project-Name');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req, limit = 64 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new UserError('Body too large', 413);
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new UserError('Invalid JSON'); }
  }

  // What members who aren't project admins see: the map of bases and machines, without network addresses,
  // the log, logins or base receivers.
  const viewerRover = ({ addr, agent, ...r }) => r;
  const viewerMount = ({ addr, manualPosition, ...m }) => m;
  const viewerMounts = P => state.mountpointViews(P).map(viewerMount);
  function viewerSnapshot(P) {
    const s = state.snapshot(P);
    return { ...s, mountpoints: s.mountpoints.map(viewerMount), rovers: s.rovers.map(viewerRover), receivers: [], log: [] };
  }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

    try {
      // Caddy on-demand TLS asks here before issuing a certificate for a receiver's web UI host.
      // Only answered for local requests (Caddy's reverse-proxied traffic carries X-Forwarded-For).
      if (url.pathname === '/tls-ask' && !req.headers['x-forwarded-for']) {
        const ok = isReceiverHost(config, url.searchParams.get('domain'));
        res.writeHead(ok ? 200 : 404); return res.end();
      }
      if (url.pathname === '/api/health') {
        return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000) });
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const projectId = String(req.headers['x-connect-project'] || url.searchParams.get('project') || '');
      let projectName = '';
      try { projectName = decodeURIComponent(String(req.headers['x-connect-project-name'] || '')); } catch { /* ignore */ }
      const { user, project, admin } = await access(token, projectId, projectName);
      const P = project.id;
      const devices = projects.devicesFor(P);
      const history = projects.historyFor(P);
      const ownMount = name => {
        const m = config.mountpoints.find(x => x.name === name);
        return m && projects.projectOf(m) === P ? m : null;
      };
      const pushDevices = () => broadcast({ type: 'devices', devices: devices.list() }, P, true);

      // GET /api/project   POST /api/project/base-password (new base password for this project)
      if (req.method === 'GET' && url.pathname === '/api/project') return send(res, 200, projectInfo(project, admin));
      if (req.method === 'POST' && url.pathname === '/api/project/base-password') {
        if (!admin) throw new UserError('Only project admins can change the base password', 403);
        projects.newPassword(P);
        state.event('project.base_password_changed', { project: P, by: user.email });
        const info = projectInfo(projects.get(P), true);
        broadcast({ type: 'project', project: info }, P, true);
        return send(res, 200, info);
      }

      // GET /api/snapshot   GET /api/mountpoints
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, admin ? state.snapshot(P) : viewerSnapshot(P));
      if (req.method === 'GET' && url.pathname === '/api/mountpoints') return send(res, 200, admin ? state.mountpointViews(P) : viewerMounts(P));

      // Everything below manages the project: project admins only
      if (!admin) throw new UserError('Only project admins can do this', 403);

      // GET /api/log?before=<ISO time>&limit=200 -> older entries of this project's log (kept for good)
      if (req.method === 'GET' && url.pathname === '/api/log') {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return send(res, 200, { events: projects.readEvents(P, { before: url.searchParams.get('before') || null, limit }) });
      }

      // POST /api/project/geo -> the project's coordinate system, for easting/northing in the monthly reports
      if (req.method === 'POST' && url.pathname === '/api/project/geo') {
        const b = await readJson(req, 32 * 1024);
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
        const geo = {
          crsName: str(b.crsName, 200), code: str(b.code, 40),
          proj4: typeof b.proj4 === 'string' && /^\+proj=/.test(b.proj4) ? b.proj4.slice(0, 2000) : null,
          geoid: b.geoid && /^[A-Za-z0-9_.\-]{1,80}\.tif$/.test(String(b.geoid.file || '')) ? { name: str(b.geoid.name, 60), datum: str(b.geoid.datum, 30), file: String(b.geoid.file) } : null,
          at: new Date().toISOString(),
        };
        projects.setGeo(P, geo);
        return send(res, 200, { ok: true });
      }

      // Monthly reports. GET /api/reports  GET /api/reports/:month/:mount.(pdf|csv)
      // POST /api/reports/:month/:mount/uploaded   POST /api/reports/preview {month?} -> PDF of a month so far
      if (parts[1] === 'reports') {
        if (req.method === 'GET' && parts.length === 2) return send(res, 200, { timeZone: config.reportTimeZone, reports: listReports(projects, P) });
        if (req.method === 'GET' && parts.length === 4) {
          const m = decodeURIComponent(parts[3]).match(/^(.+)\.(pdf|csv)$/);
          const f = m && reportFile(projects, P, parts[2], m[1], m[2]);
          if (!f) return send(res, 404, { error: 'Report not found' });
          res.writeHead(200, { 'Content-Type': m[2] === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
          return fs.createReadStream(f).pipe(res);
        }
        if (req.method === 'POST' && parts[4] === 'uploaded') {
          const mount = decodeURIComponent(parts[3]);
          if (!markUploaded(projects, P, parts[2], mount, user.email)) return send(res, 404, { error: 'Report not found' });
          state.event('report.uploaded', { project: P, mount, month: parts[2], by: user.email });
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && parts[2] === 'preview') {
          const body = await readJson(req);
          const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : monthOf(config.reportTimeZone, Date.now());
          const mount = String(body.mount || '');
          const r = await buildMonth({ config, state, projects, projectId: P, month, store: false });
          try {
            const one = r.reports.find(x => x.mount === mount) || r.reports[0];
            if (!one) return send(res, 404, { error: 'No base or machine activity in that month yet' });
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Report-Mounts': r.reports.map(x => x.mount).join(',') });
            res.end(fs.readFileSync(body.csv ? one.csv : one.pdf));
          } finally {
            fs.rmSync(r.dir, { recursive: true, force: true });
          }
          return;
        }
        if (req.method === 'POST' && parts[2] === 'generate') {
          // Builds (or rebuilds) a finished month now, e.g. for a month before reports existed
          const body = await readJson(req);
          const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : previousMonth(monthOf(config.reportTimeZone, Date.now()));
          if (monthRange(config.reportTimeZone, month).to > Date.now()) return send(res, 400, { error: 'That month has not finished yet; use preview' });
          const r = await buildMonth({ config, state, projects, projectId: P, month });
          return send(res, 200, { month, mounts: r.reports.map(x => x.mount) });
        }
      }

      // GET /api/devices/export  -> this project's logins for importing into another project
      // (POST with {serials: [...]} exports just those logins)
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/devices/export') {
        const body = req.method === 'POST' ? await readJson(req, 512 * 1024) : {};
        const wanted = Array.isArray(body.serials) ? new Set(body.serials.map(normaliseSerial)) : null;
        const logins = devices.exportAll().filter(l => !wanted || wanted.has(l.serial));
        state.event('devices.exported', { project: P, by: user.email, count: logins.length });
        return send(res, 200, { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), fromProject: project.name || P, logins });
      }

      // POST /api/devices/import {logins: [...], replace: bool}
      if (req.method === 'POST' && url.pathname === '/api/devices/import') {
        const body = await readJson(req, 2 * 1024 * 1024);
        const list = Array.isArray(body.logins) ? body.logins : [];
        if (!list.length) throw new UserError('No logins to import');
        const result = { added: 0, replaced: 0, skipped: 0, errors: [] };
        for (const rec of list) {
          try { result[devices.importOne(rec, !!body.replace)]++; } catch (err) { result.errors.push(err.message); }
        }
        devices.save();
        // A replaced login may have a different password: end live sessions so they sign in again
        if (body.replace) {
          const serials = new Set(list.map(r => normaliseSerial(r?.serial)));
          for (const c of state.clients.values()) {
            if (c.project === P && serials.has(c.serial)) { c.endReason = `login replaced by import (${user.email})`; c.close(); }
          }
        }
        state.event('devices.imported', { project: P, by: user.email, added: result.added, replaced: result.replaced, skipped: result.skipped });
        pushDevices();
        return send(res, 200, result);
      }

      // Login details for emailing to the operator. GET /api/devices/:serial/credentials -> the email for one login;
      // POST /api/devices/email {serials} -> sends them through the caster's SMTP server (if one is set up)
      const credentialsFor = d => compose({
        casterName: config.casterName,
        projectName: project.name,
        host: config.publicHost,
        port: config.ntripPort,
        device: d,
        password: devices.password(d.serial),
        mounts: state.mountpointViews(P).map(m => ({ name: m.name, format: /detecting/i.test(m.detectedFormat || m.format || '') ? '' : m.detectedFormat || m.format })),
      });
      if (req.method === 'GET' && url.pathname === '/api/devices/credentials') {
        const list = devices.list().filter(d => d.enabled);
        state.event('device.credentials_opened', { project: P, serial: `all (${list.length})`, by: user.email });
        return send(res, 200, list.map(d => ({ serial: d.serial, label: d.label, ...credentialsFor(d), passwordOnRecord: d.passwordOnRecord })));
      }
      if (req.method === 'GET' && parts[1] === 'devices' && parts[3] === 'credentials') {
        const d = devices.get(decodeURIComponent(parts[2]));
        if (!d) return send(res, 404, { error: 'Login not found' });
        state.event('device.credentials_opened', { project: P, serial: d.serial, by: user.email });
        return send(res, 200, { ...credentialsFor(d), passwordOnRecord: d.passwordOnRecord });
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/email') {
        if (!emailEnabled(config)) throw new UserError('Email sending is not set up on the caster');
        const body = await readJson(req);
        const wanted = Array.isArray(body.serials) ? new Set(body.serials.map(normaliseSerial)) : null;
        const list = devices.list().filter(d => d.enabled && (!wanted || wanted.has(d.serial)));
        const result = { sent: [], skipped: [], failed: [] };
        for (const d of list) {
          const msg = credentialsFor(d);
          if (!msg.to.length) { result.skipped.push({ serial: d.serial, reason: 'no email address' }); continue; }
          try {
            await sendEmail(config, msg);
            result.sent.push({ serial: d.serial, to: msg.to });
            state.event('device.credentials_emailed', { project: P, serial: d.serial, to: msg.to.join(', '), by: user.email });
          } catch (err) {
            console.error(`Email to ${msg.to.join(', ')} failed: ${err.message}`);
            result.failed.push({ serial: d.serial, reason: err.message.slice(0, 200) });
          }
        }
        return send(res, 200, result);
      }

      // GET /api/devices/:serial/track?start=<session start ms> -> that session's trail
      if (req.method === 'GET' && parts[1] === 'devices' && parts[3] === 'track') {
        const serial = normaliseSerial(decodeURIComponent(parts[2]));
        const start = Number(url.searchParams.get('start'));
        if (!Number.isSafeInteger(start)) throw new UserError('Which session? Give its start time');
        return send(res, 200, { serial, start, points: await state.trailFor(P, serial, start) });
      }

      // GET /api/devices/:serial/history?days=30  (days=0 for everything kept)
      if (req.method === 'GET' && parts[1] === 'devices' && parts[3] === 'history') {
        const serial = normaliseSerial(decodeURIComponent(parts[2]));
        const device = devices.get(serial);
        if (!device) return send(res, 404, { error: `Device ${serial} not found` });
        const days = Math.max(0, Number(url.searchParams.get('days') ?? 30));
        const fromMs = days ? Date.now() - days * 86_400_000 : 0;
        const live = state.roverViews(P).filter(c => c.serial === serial);
        return send(res, 200, { device, days, keepDays: 0, live, records: history.read(serial, { fromMs }) });
      }

      // /api/devices[/:serial]
      if (parts[1] === 'devices') {
        const serial = parts[2] ? normaliseSerial(decodeURIComponent(parts[2])) : null;
        if (req.method === 'GET' && !serial) return send(res, 200, devices.list());
        if (req.method === 'POST' && !serial) {
          const d = devices.add(await readJson(req));
          state.event('device.added', { project: P, serial: d.serial, by: user.email });
          pushDevices();
          return send(res, 201, d);
        }
        if (req.method === 'PATCH' && serial) {
          const body = await readJson(req);
          const d = devices.update(serial, body);
          state.event('device.updated', { project: P, serial, by: user.email, fields: Object.keys(body).filter(k => k !== 'password').concat(body.password ? ['password'] : []) });
          // Only drop a live connection when it is no longer allowed: login disabled, password changed,
          // or its mountpoint taken off the list. Editing names and contact details leaves it connected.
          for (const c of state.clients.values()) {
            if (c.project !== P || c.serial !== serial) continue;
            let why = null;
            if (!d.enabled) why = `login disabled by ${user.email}`;
            else if (body.password) why = `password changed by ${user.email}`;
            else if (d.mountpoints.length && !d.mountpoints.includes(c.mount)) why = `${c.mount} removed from the login by ${user.email}`;
            if (why) { c.endReason = why; c.close(); }
            else if (body.label !== undefined) c.label = d.label; // keep live machine names in step with the login
          }
          pushDevices();
          return send(res, 200, d);
        }
        if (req.method === 'DELETE' && serial) {
          devices.remove(serial);
          for (const c of state.clients.values()) {
            if (c.project !== P || c.serial !== serial) continue;
            c.endReason = `login deleted by ${user.email}`;
            c.close();
          }
          state.event('device.removed', { project: P, serial, by: user.email });
          pushDevices();
          return send(res, 200, { ok: true });
        }
      }

      // PUT /api/mountpoints/:name/position {lat, lon, h?}   DELETE /api/mountpoints/:name/position
      if (parts[1] === 'mountpoints' && parts[2] && parts[3] === 'position' && (req.method === 'PUT' || req.method === 'DELETE')) {
        const name = decodeURIComponent(parts[2]);
        const m = ownMount(name);
        if (!m) return send(res, 404, { error: `Mountpoint ${name} not found` });
        if (req.method === 'DELETE') {
          state.positions.clear(name);
          state.event('mountpoint.position_cleared', { project: P, mount: name, by: user.email });
        } else {
          const p = state.positions.set(name, await readJson(req), user.email);
          state.event('mountpoint.position_set', { project: P, mount: name, by: user.email, lat: p.lat, lon: p.lon });
        }
        broadcast({ type: 'mountpoints', mountpoints: state.mountpointViews(P) }, P, true);
        broadcast({ type: 'mountpoints', mountpoints: viewerMounts(P) }, P, false, true);
        return send(res, 200, state.sourceView(m));
      }

      // DELETE /api/mountpoints/:name  (only mountpoints a base created, and only while it is offline)
      if (req.method === 'DELETE' && parts[1] === 'mountpoints' && parts[2]) {
        const name = decodeURIComponent(parts[2]);
        const m = ownMount(name);
        if (!m) return send(res, 404, { error: `Mountpoint ${name} not found` });
        if (!m.auto) return send(res, 400, { error: 'Configured mountpoints are changed in the caster config file' });
        if (state.sources.has(name)) return send(res, 409, { error: 'The base is still sending to this mountpoint' });
        config.autoMounts.remove(name);
        state.event('mountpoint.removed', { project: P, mount: name, by: user.email });
        return send(res, 200, { ok: true });
      }

      // Base receivers: POST /api/receivers, PATCH/DELETE /api/receivers/:id
      if (parts[1] === 'receivers' && parts.length <= 3 && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        const id = parts[2] ? decodeURIComponent(parts[2]) : null;
        let r;
        if (req.method === 'POST' && !id) {
          r = receiverStore.add(await readJson(req), P);
          state.event('receiver.added', { project: P, receiver: r.id, name: r.name, by: user.email });
        } else if (req.method === 'PATCH' && id) {
          r = receiverStore.update(id, await readJson(req), P);
          state.event('receiver.updated', { project: P, receiver: id, by: user.email });
        } else if (req.method === 'DELETE' && id) {
          receiverStore.remove(id, P);
          state.receiverStatus.delete(id);
          state.event('receiver.removed', { project: P, receiver: id, by: user.email });
        } else {
          return send(res, 404, { error: 'Not found' });
        }
        broadcast({ type: 'receivers', receivers: state.receiverViews(P) }, P, true);
        return send(res, 200, r ? state.receiverViews(P).find(x => x.id === r.id) : { ok: true });
      }

      // POST /api/receivers/:id/webui -> one-time link to the receiver's own web interface
      if (req.method === 'POST' && parts[1] === 'receivers' && parts[3] === 'webui') {
        const r = receiverStore.own(decodeURIComponent(parts[2]), P);
        if (!r.webUrl) return send(res, 404, { error: 'This receiver has no web UI configured' });
        return send(res, 200, { url: startLink(config, tokens, r, user.email), expiresInSec: 60 });
      }

      // POST /api/rovers/:id/disconnect
      if (req.method === 'POST' && parts[1] === 'rovers' && parts[3] === 'disconnect') {
        const c = state.clients.get(parts[2]);
        if (!c || c.project !== P) return send(res, 404, { error: 'Rover not connected' });
        state.event('rover.kicked', { project: P, serial: c.serial, by: user.email });
        c.endReason = `disconnected by ${user.email}`;
        c.close();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof UserError || (err.status && err.status < 500)) return send(res, err.status || 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Server error' });
    }
  });

  // ---------------------------------------------------------------- WebSocket feed (one project per socket)
  // Updates are compressed: a project with hundreds of machines sends a lot of repetitive JSON every second
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 64 * 1024,
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 4, memLevel: 7 }, serverNoContextTakeover: false, clientNoContextTakeover: true, concurrencyLimit: 4 },
  });
  const authed = new Set();

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) {
      ws.close(4003, 'Origin not allowed');
      return;
    }
    const authTimer = setTimeout(() => ws.close(4001, 'Auth timeout'), 10_000);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'auth' || authed.has(ws)) return;
      let granted;
      try {
        granted = await access(msg.token, String(msg.project || ''), String(msg.projectName || ''));
      } catch (err) {
        clearTimeout(authTimer);
        ws.close(err.status === 403 ? 4003 : 4001, err.message.slice(0, 100));
        return;
      }
      clearTimeout(authTimer);
      ws.project = granted.project.id;
      ws.admin = granted.admin;
      if (!granted.admin) console.log(`${granted.user.email} opened project ${ws.project} (view only)`);
      authed.add(ws);
      ws.send(JSON.stringify({
        type: 'hello', user: granted.user, project: projectInfo(granted.project, granted.admin),
        snapshot: granted.admin ? state.snapshot(ws.project) : viewerSnapshot(ws.project),
        devices: granted.admin ? projects.devicesFor(ws.project).list() : [],
      }));
    });
    ws.on('close', () => { clearTimeout(authTimer); authed.delete(ws); });
  });

  /** Sends to a project's sockets: everyone, admins only, or (viewersOnly) members who aren't admins. */
  function broadcast(msg, project, adminsOnly = false, viewersOnly = false) {
    const data = JSON.stringify(msg);
    for (const ws of authed) {
      if (ws.project !== project || ws.readyState !== ws.OPEN) continue;
      if ((adminsOnly && !ws.admin) || (viewersOnly && ws.admin)) continue;
      ws.send(data);
    }
  }

  // Push discrete events immediately (only to their own project); positions and rates once a second.
  // The log is for admins; members who aren't admins just see the map
  state.on('event', ev => { if (ev.project) broadcast({ type: 'event', event: ev }, ev.project, true); });
  const dirty = new Set();
  state.on('position', c => dirty.add(c.id));
  state.on('tick', () => {
    if (!authed.size) { dirty.clear(); return; }
    const open = new Set([...authed].map(ws => ws.project));
    for (const P of open) {
      const positions = [];
      for (const id of dirty) {
        const c = state.clients.get(id);
        if (c?.project === P && c.gga) positions.push({ id, gga: c.gga, ggaAt: c.ggaAt, point: c.track[c.track.length - 1] || null });
      }
      const tick = { type: 'tick', serverTime: Date.now(), positions };
      broadcast({ ...tick, mountpoints: state.mountpointViews(P), rovers: state.roverViews(P), receivers: state.receiverViews(P) }, P, true);
      broadcast({ ...tick, mountpoints: viewerMounts(P), rovers: state.roverViews(P).map(viewerRover), receivers: [] }, P, false, true);
    }
    dirty.clear();
  });

  // Drop dead dashboard sockets
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000).unref();

  server.listen(config.dashboardPort, '127.0.0.1', () => {
    console.log(`Dashboard API listening on 127.0.0.1:${config.dashboardPort} (expose it via the TLS proxy)`);
  });
  return server;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
