/* Connect-NTRIP: Trimble Connect extension showing the caster's bases and machines live. */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { baseStyle, createBasemap } from './map/basemap';
import { connectToHost, type HostConnection } from './connect/workspace';
import { ProjectFiles } from './connect/projectFiles';
import { RangeClient } from './core/geotiffTiles';
import { fromProject, getEpsgCode, getProjectCrsName, initGeoreference, onGeoChange, projectProj4, toProject } from './core/geo';
import { geoidSeparation, onGeoidValue, projectGeoid } from './core/geoid';
import { chooseSource } from './ui/sourceDialog';
import { loadProjectSettings, loadShared, loadSharedPicture, saveProjectSettings, saveShared, saveSharedPicture, type SharedMap } from './connect/sharedSession';
import type { LoginEmail } from './types';
import type { CasterMessage, Device, HistoryRecord, HistoryReply, LogEvent, Mountpoint, Profile, Receiver, Rover, SessionRecord, ProjectInfo, LoginExport } from './types';

const STALE_MS = 15_000;
const FIX_COLOURS: Record<number, string> = { 0: '--q0', 1: '--q1', 2: '--q2', 3: '--q1', 4: '--q4', 5: '--q5', 6: '--q1', 7: '--q1', 8: '--q1', 9: '--q2' };
const FIX_NAMES: Record<number, string> = { 0: 'No fix', 1: 'Autonomous', 2: 'DGPS', 3: 'PPS', 4: 'RTK fixed', 5: 'RTK float', 6: 'Dead reckoning', 7: 'Manual', 8: 'Simulator', 9: 'SBAS' };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
/**
 * Updates `el` to match `html`, changing only the parts that differ. The lists are redrawn every second
 * with fresh numbers; replacing them wholesale would swallow clicks on their buttons mid-click.
 */
function morph(el: HTMLElement, html: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  syncChildren(el, tpl.content);
}
function syncChildren(target: Node, source: Node) {
  const next = [...source.childNodes];
  let i = 0;
  for (; i < next.length; i++) {
    const want = next[i];
    const have = target.childNodes[i];
    if (!have) { target.appendChild(want.cloneNode(true)); continue; }
    if (have.nodeType !== want.nodeType || have.nodeName !== want.nodeName) { target.replaceChild(want.cloneNode(true), have); continue; }
    if (want.nodeType !== Node.ELEMENT_NODE) {
      if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
      continue;
    }
    const h = have as Element, w = want as Element;
    if (h.outerHTML === w.outerHTML) continue;
    for (const a of [...h.attributes]) if (!w.hasAttribute(a.name)) h.removeAttribute(a.name);
    for (const a of [...w.attributes]) if (h.getAttribute(a.name) !== a.value) h.setAttribute(a.name, a.value);
    syncChildren(h, w);
  }
  while (target.childNodes.length > next.length) target.removeChild(target.lastChild!);
}

function when(ms: number) {
  return new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ settings
// Browser storage can be blocked or wiped inside the Connect frame, so values are also kept in memory.
const memory = new Map<string, string>();
function store(key: string, value?: string | null): string | null {
  if (value === undefined) {
    try {
      const v = localStorage.getItem(`connect-ntrip.${key}`);
      if (v !== null) return v;
    } catch {
      /* storage blocked */
    }
    return memory.get(key) ?? null;
  }
  if (value === null || value === '') memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null || value === '') localStorage.removeItem(`connect-ntrip.${key}`);
    else localStorage.setItem(`connect-ntrip.${key}`, value);
  } catch {
    /* storage blocked */
  }
  return null;
}
/** The caster used when a project hasn't chosen one (set at build time). */
const DEFAULT_CASTER_URL = String(import.meta.env.VITE_DEFAULT_CASTER_URL || '').replace(/\/+$/, '');
/**
 * Inside Connect the caster URL belongs to the project: it is saved as a project file so everyone on the
 * project connects to the same caster, and kept in this browser per project so it connects straight away.
 * Outside Connect (local testing) it is kept in this browser only.
 */
let inConnectProject: string | null = null;
const settings = {
  get casterUrl() { return (inConnectProject ? store(`casterUrl.${inConnectProject}`) : store('casterUrl')) || DEFAULT_CASTER_URL; },
  get devToken() { return store('devToken') || ''; },
};

// ------------------------------------------------------------------ state
const app = {
  host: null as HostConnection | null,
  ws: null as WebSocket | null,
  retry: 0,
  serverOffset: 0,
  mountpoints: [] as Mountpoint[],
  rovers: new Map<string, Rover>(),
  devices: [] as Device[],
  receivers: [] as Receiver[],
  webUiOpen: null as string | null,
  log: [] as LogEvent[],
  selected: null as string | null,
  fitted: false,
  /** How many things were on the map when it was last framed automatically */
  framedCount: 0,
  editing: null as string | null,
  project: null as ProjectInfo | null,
  showBasePassword: false,
  pendingImport: null as LoginExport | null,
  /** Monthly reports the caster has made for this project (admins) */
  reports: [] as { month: string; mount: string; generatedAt: string; uploadedAt: string | null; uploadedBy: string | null }[],
  reportStatus: '' as string,
  /** Whether the "Connect a base" card is open; null = open only while the project has no bases */
  baseCardOpen: null as boolean | null,
  reportsOpen: false,
};

/** The Connect project the extension is open in ("local-dev" when opened outside Connect for testing). */
const projectId = () => app.host?.projectId || 'local-dev';
const projectName = () => app.host?.projectName || (app.host ? '' : 'Local testing');
let projectFiles: ProjectFiles | null = null;
let currentProjectId: string | null = null;

// ------------------------------------------------------------------ sharing base maps with the project (as the 360 Imagery Viewer does)
const SHARE_KEY = (id: string) => `connect-ntrip.share.${id}`;
const isSharing = (id: string) => {
  try {
    return localStorage.getItem(SHARE_KEY(id)) === '1';
  } catch {
    return false;
  }
};
let shareTimer: number | undefined;
let shareError: string | null = null;

/** Saves the base maps into the project a few seconds after they change, once sharing has been turned on. */
function scheduleShare() {
  if (!currentProjectId || !projectFiles || !isSharing(currentProjectId)) return;
  window.clearTimeout(shareTimer);
  shareTimer = window.setTimeout(() => void shareNow(), 3000);
}

/** GeoTIFF pictures already in the project's folder, so each is uploaded once. */
const uploadedPictures = new Set<string>();
const SHARED_TIFFS_KEY = (id: string) => `connect-ntrip.sharedtiffs.${id}`;
const rememberSharedTiffs = (projectId: string, ids: string[]) => {
  try {
    localStorage.setItem(SHARED_TIFFS_KEY(projectId), JSON.stringify(ids));
  } catch {
    /* storage may be unavailable */
  }
};
const recallSharedTiffs = (projectId: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SHARED_TIFFS_KEY(projectId)) ?? '[]') as string[];
  } catch {
    return [];
  }
};

async function shareNow(): Promise<boolean> {
  if (!projectFiles || !currentProjectId) return false;
  try {
    // Project files are read in place; only a reduced picture of a file from someone's computer needs uploading, once.
    const tiffs = basemap.geoTiffs();
    for (const { info, picture } of tiffs) {
      if (!picture || uploadedPictures.has(info.id)) continue;
      await saveSharedPicture(projectFiles, info.id, picture);
      uploadedPictures.add(info.id);
    }
    await saveShared(projectFiles, { version: 1, savedAt: Date.now(), geotiffs: tiffs.map((t) => t.info) });
    rememberSharedTiffs(currentProjectId, tiffs.map((t) => t.info.id));
    shareError = null;
    return true;
  } catch (err) {
    shareError = err instanceof Error ? err.message : String(err);
    console.warn('[ntrip] could not share the base maps', err);
    return false;
  }
}

/** Adds the GeoTIFF base maps others shared, and drops ones that were removed from the shared list. */
async function restoreSharedGeoTiffs(project: ProjectFiles, projectId: string, shared: SharedMap) {
  await basemap.loaded();
  const listed = shared.geotiffs ?? [];
  const had = recallSharedTiffs(projectId);
  for (const t of basemap.geoTiffs()) {
    if (had.includes(t.info.id) && !listed.some((x) => x.id === t.info.id)) basemap.removeSharedGeoTiff(t.info.id);
  }
  rememberSharedTiffs(projectId, listed.map((t) => t.id));
  for (const info of listed) {
    uploadedPictures.add(info.id);
    if (basemap.geoTiffs().some((t) => t.info.id === info.id)) continue;
    try {
      if (info.item && info.tiles) {
        await basemap.addSharedGeoTiff(info, null);
        continue;
      }
      const picture = await loadSharedPicture(project, info.id);
      if (picture) await basemap.addSharedGeoTiff(info, picture);
      else console.warn('[ntrip] the picture for shared GeoTIFF', info.name, 'is missing from the project');
    } catch (err) {
      console.warn('[ntrip] could not load the shared GeoTIFF', info.name, err);
    }
  }
}

const serverNow = () => Date.now() + app.serverOffset;
const isStale = (r: Rover) => !r.ggaAt || serverNow() - r.ggaAt > STALE_MS;
const roverName = (r: Rover) => r.label || r.serial;
const deviceOf = (serial: string) => app.devices.find((d) => d.serial === serial);

const tel = (v: string) => `<a href="tel:${esc(v.replace(/[^0-9+]/g, ''))}">${esc(v)}</a>`;
const mail = (v: string) => `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
/** One line per person: "Operator · name · phone · email" with call and email links. */
function profileLines(p: Profile | undefined) {
  if (!p) return '';
  const line = (role: string, name: string, phone: string, email: string) =>
    name || phone || email
      ? `<div class="profile-line"><span class="role">${role}</span>${name ? `<span class="who">${esc(name)}</span>` : ''}${phone ? tel(phone) : ''}${email ? mail(email) : ''}</div>`
      : '';
  return line('Company', p.companyName, p.companyPhone, p.companyEmail) + line('Operator', p.operatorName, p.operatorPhone, p.operatorEmail);
}
function roverColour(r: Rover) {
  if (!r.gga || !r.gga.hasPosition || isStale(r)) return css('--stale');
  return css(FIX_COLOURS[r.gga.quality] || '--q1');
}

// ------------------------------------------------------------------ map
const mapEl = $('#map');
const map = new maplibregl.Map({ container: mapEl, style: baseStyle, center: [144.9631, -37.8136], zoom: 13, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const basemap = createBasemap(map, $('.map-wrap'), {
  geoTiffsChanged: () => scheduleShare(),
  sharing: {
    isOn: () => !!currentProjectId && isSharing(currentProjectId),
    available: () => !!currentProjectId && !!projectFiles,
    async set(on) {
      if (!currentProjectId || !projectFiles) return 'open the extension inside a Trimble Connect project first';
      if (on && !(await shareNow())) return shareError ?? 'unknown error';
      try {
        localStorage.setItem(SHARE_KEY(currentProjectId), on ? '1' : '0');
      } catch {
        /* storage may be unavailable */
      }
      return null;
    },
  },
  beforeId: () => (map.getLayer('trails-casing') ? 'trails-casing' : undefined),
  hasContent: () => app.mountpoints.some((m) => m.position) || [...app.rovers.values()].some((r) => r.gga?.hasPosition),
  chooseGeoTiff: async () => {
    const choice = await chooseSource({
      title: 'Choose GeoTIFFs for the base map',
      accept: '.tif,.tiff,image/tiff',
      multiple: true,
      suits: (name) => /\.tiff?$/i.test(name),
      project: projectFiles,
    });
    if (!choice) return [];
    if ('files' in choice) return choice.files.map((file) => ({ file }));
    // Project files are read in place a piece at a time, never downloaded whole (they can be tens of GB).
    return projectFiles ? choice.project.map((item) => ({ item })) : [];
  },
  projectTiffClient: (item) => {
    const project = projectFiles;
    if (!project) return null;
    // The download address expires, so it is kept briefly and fetched again when it stops working.
    let cached: { url: string; at: number } | null = null;
    return new RangeClient(async (fresh) => {
      if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.url;
      cached = { url: await project.downloadUrl(item), at: Date.now() };
      return cached.url;
    });
  },
});

let mapReady = false;
// Start drawing once the map's style is ready, not when its first background tiles arrive ('load'): if the tile
// server is slow or blocked (e.g. by a site firewall) bases and machines must still appear.
const onMapReady = () => {
  if (mapReady) return;
  map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trails-casing', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 3, 'line-opacity': 0.85 } });
  // Trails from a login's history, coloured by fix quality
  map.addSource('history-trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'history-trails-casing', type: 'line', source: 'history-trails', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1b1f24', 'line-width': 6, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'history-trails', type: 'line', source: 'history-trails', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 3.5 } });
  map.addLayer({ id: 'history-ends', type: 'circle', source: 'history-trails', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  mapReady = true;
  basemap.onLoad();
  renderMap();
};
map.on('style.load', onMapReady);
map.on('load', onMapReady);
if (map.isStyleLoaded()) onMapReady();
new ResizeObserver(() => map.resize()).observe(mapEl);
// Elevations need the geoid grid and the project's coordinate system, which arrive a moment after start
const redrawPositions = () => {
  renderBases();
  for (const [key] of baseMarkers) if (popupFor === `base:${key}`) popup.setHTML(basePopup(key));
};
onGeoidValue(redrawPositions);
onGeoChange(redrawPositions);
// Once the person pans, zooms or turns the map, leave it where they put it
for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
  map.on(ev, (e: { originalEvent?: Event }) => {
    if (e.originalEvent) app.fitted = true;
  });
}

const baseMarkers = new Map<string, { marker: maplibregl.Marker; online: boolean; label: string }>();
const roverMarkers = new Map<string, { marker: maplibregl.Marker; key: string; label: string }>();

function baseElement(online: boolean, label: string) {
  const el = document.createElement('div');
  el.className = 'base-marker';
  el.innerHTML = `<svg viewBox="0 0 30 30"><path d="M15 3 27 26H3Z" fill="${online ? css('--base') : '#8c8b96'}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><circle cx="15" cy="18" r="3" fill="#fff"/></svg><span class="map-label">${esc(label)}</span>`;
  return el;
}

function roverElement(r: Rover) {
  const el = document.createElement('div');
  el.className = 'rover-marker';
  const pulse = r.gga?.quality === 4 && !isStale(r) ? ' pulse' : '';
  el.innerHTML = `<div class="rover-dot${pulse}" style="background:${roverColour(r)}"></div><span class="map-label">${esc(roverName(r))}</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    select(r.id, false);
  });
  return el;
}

function duration(ms: number) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
const rate = (bps: number) => (bps >= 1024 ? `${(bps / 1024).toFixed(1)} kB/s` : `${bps} B/s`);
const bytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(0)} kB` : `${n} B`);

function popupPeople(p: Profile | undefined) {
  if (!p) return '';
  const cell = (name: string, phone: string, email: string) => [name && esc(name), phone && tel(phone), email && mail(email)].filter(Boolean).join('<br>');
  return [
    p.companyName || p.companyPhone || p.companyEmail ? `<tr><td>Company</td><td>${cell(p.companyName, p.companyPhone, p.companyEmail)}</td></tr>` : '',
    p.operatorName || p.operatorPhone || p.operatorEmail ? `<tr><td>Operator</td><td>${cell(p.operatorName, p.operatorPhone, p.operatorEmail)}</td></tr>` : '',
  ].join('');
}

function roverPopup(r: Rover) {
  const g = r.gga;
  return `<b>${esc(roverName(r))}</b><table>
    <tr><td>Serial</td><td>${esc(r.serial)}</td></tr>
    ${popupPeople(deviceOf(r.serial)?.profile)}
    <tr><td>Mountpoint</td><td>${esc(r.mount)}</td></tr>
    <tr><td>Fix</td><td>${esc(g?.fix || '—')}</td></tr>
    <tr><td>Satellites</td><td>${g?.sats ?? '—'}</td></tr>
    <tr><td>HDOP</td><td>${g?.hdop ?? '—'}</td></tr>
    <tr><td>Corr. age</td><td>${g?.ageOfCorrections != null ? `${g.ageOfCorrections} s` : '—'}</td></tr>
    <tr><td>Connection</td><td title="${esc(netTitle(r))}">${netBars(r)}</td></tr>
    <tr><td>Ping</td><td>${r.net?.pingMs != null ? `${r.net.pingMs} ms` : '—'}</td></tr>
    <tr><td>Position</td><td>${g?.hasPosition ? `${g.lat!.toFixed(7)}, ${g.lon!.toFixed(7)}` : '—'}</td></tr>
    <tr><td>Height</td><td>${g?.alt != null ? `${g.alt.toFixed(3)} m` : '—'}</td></tr>
    <tr><td>Connected</td><td>${duration(serverNow() - r.connectedAt)}</td></tr>
    <tr><td>Protocol</td><td>${esc(r.protocol)}</td></tr>
  </table>`;
}

const popup = new maplibregl.Popup({ offset: 14, closeButton: true, maxWidth: '300px' });
let popupFor: string | null = null;
popup.on('close', () => (popupFor = null));
function openPopup(kind: 'rover' | 'base', id: string, lngLat: maplibregl.LngLatLike, html: string) {
  popupFor = `${kind}:${id}`;
  popup.setLngLat(lngLat).setHTML(html).addTo(map);
}

/** Machine names show unless turned off, or too many machines are in view to read them (zoom in to see them). */
const MAX_LABELS = 40;
function updateLabels() {
  const on = $<HTMLInputElement>('#labelsToggle').checked;
  let crowded = false;
  if (on && app.rovers.size > MAX_LABELS && mapReady) {
    const b = map.getBounds();
    let n = 0;
    for (const r of app.rovers.values()) {
      const g = r.gga;
      if (g?.hasPosition && b.contains([g.lon!, g.lat!]) && ++n > MAX_LABELS) { crowded = true; break; }
    }
  }
  const wrap = mapEl.parentElement!;
  wrap.classList.toggle('hide-labels', !on || crowded);
  $('#labelsToggle').parentElement!.title = crowded ? `More than ${MAX_LABELS} machines in view: zoom in to see their names` : '';
}
map.on('moveend', () => updateLabels());

const TRAIL_REDRAW_MS = 5000;
let lastTrailDraw = 0;
let trailsWereOn = true;
/** The last `keep` points of a trail, spaced evenly through the older part so its shape stays. */
function thin<T>(pts: T[], keep: number): T[] {
  if (pts.length <= keep) return pts;
  const recent = Math.min(pts.length, Math.ceil(keep / 3));
  const older = pts.slice(0, pts.length - recent);
  const step = older.length / (keep - recent);
  const out: T[] = [];
  for (let i = 0; i < older.length; i += step) out.push(older[Math.floor(i)]);
  return [...out, ...pts.slice(pts.length - recent)];
}

function renderMap() {
  if (!mapReady) return;
  updateLabels();

  // Bases: one receiver usually feeds several mountpoints (RTCM, CMRx, CMR+), so mountpoints within ~2 m share one marker.
  const groups: { lat: number; lon: number; mounts: Mountpoint[] }[] = [];
  for (const m of app.mountpoints) {
    if (!m.position) continue;
    const here = new maplibregl.LngLat(m.position.lon, m.position.lat);
    const g = groups.find((x) => here.distanceTo(new maplibregl.LngLat(x.lon, x.lat)) < 2);
    if (g) g.mounts.push(m);
    else groups.push({ lat: m.position.lat, lon: m.position.lon, mounts: [m] });
  }
  const seen = new Set<string>();
  for (const g of groups) {
    const best = g.mounts.find((m) => m.online && m.position!.from !== 'config') || g.mounts[0];
    const ll: [number, number] = [best.position!.lon, best.position!.lat];
    const key = g.mounts.map((m) => m.name).join('|');
    const online = g.mounts.some((m) => m.online);
    const receiver = app.receivers.find((r) => r.mountpoints.some((mp) => g.mounts.some((m) => m.name === mp)));
    const label = receiver ? receiver.name : g.mounts.map((m) => m.name).join(' · ');
    seen.add(key);
    let entry = baseMarkers.get(key);
    if (!entry || entry.online !== online || entry.label !== label) {
      entry?.marker.remove();
      const el = baseElement(online, label);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(ll).addTo(map);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openPopup('base', key, marker.getLngLat(), basePopup(key));
      });
      entry = { marker, online, label };
      baseMarkers.set(key, entry);
    }
    entry.marker.setLngLat(ll);
    if (popupFor === `base:${key}`) popup.setHTML(basePopup(key));
  }
  for (const [key, e] of baseMarkers) if (!seen.has(key)) { e.marker.remove(); baseMarkers.delete(key); }

  // Machines
  for (const [id, r] of app.rovers) {
    const g = r.gga;
    if (!g || !g.hasPosition) { dropRover(id); continue; }
    const ll: [number, number] = [g.lon!, g.lat!];
    const key = `${roverColour(r)}|${g.quality}|${isStale(r)}|${roverName(r)}`;
    let entry = roverMarkers.get(id);
    if (!entry || entry.key !== key) {
      entry?.marker.remove();
      const marker = new maplibregl.Marker({ element: roverElement(r), anchor: 'center' }).setLngLat(ll).addTo(map);
      entry = { marker, key, label: roverName(r) };
      roverMarkers.set(id, entry);
    }
    entry.marker.setLngLat(ll);
    if (popupFor === `rover:${id}`) popup.setLngLat(ll).setHTML(roverPopup(r));
  }
  for (const id of [...roverMarkers.keys()]) if (!app.rovers.has(id)) dropRover(id);

  // Trails. Redrawing every machine's trail is the most expensive thing on the page, so with many machines it is
  // redrawn less often and with fewer points (hovering still uses every point).
  const showTrails = $<HTMLInputElement>('#trailsToggle').checked;
  const many = app.rovers.size > 40;
  const now = Date.now();
  if (!showTrails || !many || now - lastTrailDraw >= TRAIL_REDRAW_MS || trailsWereOn !== showTrails) {
    lastTrailDraw = now;
    trailsWereOn = showTrails;
    const keep = many ? Math.max(40, Math.round(12000 / app.rovers.size)) : Infinity; // ~12k points on the map at most
    const features: GeoJSON.Feature[] = showTrails
      ? [...app.rovers.values()]
          .filter((r) => (r.track?.length ?? 0) > 1)
          .map((r) => ({ type: 'Feature', properties: { colour: roverColour(r) }, geometry: { type: 'LineString', coordinates: thin(r.track!, keep).map((p) => [p[1], p[0]]) } }))
      : [];
    (map.getSource('trails') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  // Frame the map automatically only until the person moves it, and only when something new appears
  if (!app.fitted) {
    const count = app.mountpoints.filter((m) => m.position).length + [...app.rovers.values()].filter((r) => r.gga?.hasPosition).length;
    if (count > app.framedCount) {
      app.framedCount = count;
      fitAll(true);
    }
  }
}

function basePopup(key: string) {
  const mounts = app.mountpoints.filter((m) => key.split('|').includes(m.name));
  const best = mounts.find((m) => m.online && m.position?.from !== 'config') || mounts[0];
  const rows = mounts.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.format)} · ${m.online ? rate(m.rateBps) : 'offline'}</td></tr>`).join('');
  const names = key.split('|');
  const receiver = app.receivers.find((r) => r.webUi && r.mountpoints.some((m) => names.includes(m)));
  return `<b>${esc(receiver?.name || 'Base station')}</b>${receiver?.model ? `<div style="color:#6a6e79;font-size:12px">${esc(receiver.model)}</div>` : ''}<table>${rows}
    ${best?.position ? popupPosition(best.position) : ''}
  </table>${receiver ? `<button class="popup-btn" data-webui="${esc(receiver.id)}">Open receiver web UI</button>` : ''}
  ${mounts.every((m) => !positionFromData(m)) ? `<button class="popup-btn" style="background:none;color:var(--brand);border:1px solid var(--line)" data-place="${esc(names[0])}" data-place-group="${esc(names.join('|'))}">Set position</button>` : ''}`;
}

function popupPosition(p: NonNullable<Mountpoint['position']>) {
  const c = projectCoords(p);
  const rows = [...c.rows, ...c.ll].map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
  const elev = c.elevation ? `<tr><td>Elevation</td><td>${esc(c.elevation.text)}<br><small>${esc(c.elevation.note)}</small></td></tr>` : '';
  return `${rows}${elev}<tr><td></td><td><small>${esc(c.crs)} · from ${esc(p.from)}</small></td></tr>`;
}

function dropRover(id: string) {
  roverMarkers.get(id)?.marker.remove();
  roverMarkers.delete(id);
  if (popupFor === `rover:${id}`) popup.remove();
}

function fitAll(auto: boolean) {
  const pts: [number, number][] = [];
  for (const m of app.mountpoints) if (m.position) pts.push([m.position.lon, m.position.lat]);
  for (const r of app.rovers.values()) if (r.gga?.hasPosition) pts.push([r.gga.lon!, r.gga.lat!]);
  if (!pts.length) return;
  // Wait for the first machine positions before settling the automatic framing.
  if (pts.length === 1) map.jumpTo({ center: pts[0], zoom: 17 });
  else {
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    map.fitBounds(b, { padding: 60, maxZoom: 18, duration: auto ? 0 : 500 });
  }
}

function select(id: string, pan = true) {
  app.selected = id;
  const r = app.rovers.get(id);
  if (r?.gga?.hasPosition) {
    const ll: [number, number] = [r.gga.lon!, r.gga.lat!];
    if (pan) map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 17), duration: 500 });
    openPopup('rover', id, ll, roverPopup(r));
  }
  renderRovers();
  document.querySelector(`[data-rover="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ------------------------------------------------------------------ panels
function renderStats() {
  const online = app.mountpoints.filter((m) => m.online).length;
  const rovers = [...app.rovers.values()];
  const fixed = rovers.filter((r) => r.gga?.quality === 4 && !isStale(r)).length;
  $('#stats').innerHTML = `
    <div class="stat"><b>${online}/${app.mountpoints.length}</b><span>Bases online</span></div>
    <div class="stat"><b>${rovers.length}</b><span>Machines</span></div>
    <div class="stat"><b>${fixed}</b><span>RTK fixed</span></div>`;
  $('#roverCount').textContent = String(rovers.length);
}

function renderRovers() {
  const el = $('#tab-rovers');
  const rovers = [...app.rovers.values()].sort((a, b) => roverName(a).localeCompare(roverName(b)));
  if (!rovers.length) {
    morph(el, `<div class="empty">No machines connected.<br>Rovers appear here as soon as they log in to a mountpoint.</div>`);
    return;
  }
  morph(el, rovers
    .map((r) => {
      const g = r.gga;
      const stale = isStale(r);
      const fixColour = roverColour(r);
      const fixLabel = !g ? 'No GGA' : stale ? 'Stale' : g.fix || FIX_NAMES[g.quality];
      const sinceGga = r.ggaAt ? `${duration(serverNow() - r.ggaAt)} ago` : 'never';
      return `<div class="card rover${app.selected === r.id ? ' selected' : ''}" data-rover="${esc(r.id)}">
        <div class="card-head">
          <span class="dot" style="background:${fixColour}"></span>
          <div style="min-width:0">
            <div class="card-title">${esc(roverName(r))}</div>
            <div class="card-sub">${esc(r.serial)} · ${esc(r.mount)}</div>
          </div>
          <div class="right"><span class="fixtag" style="background:${fixColour}">${esc(fixLabel)}</span></div>
        </div>
        <div class="grid">
          <div><span>Satellites</span><b>${g?.sats ?? '—'}</b></div>
          <div><span>HDOP</span><b>${g?.hdop ?? '—'}</b></div>
          <div><span>Corr. age</span><b>${g?.ageOfCorrections != null ? `${g.ageOfCorrections} s` : '—'}</b></div>
          <div><span>Receiving</span><b>${rate(r.rateBps || 0)}</b></div>
          <div><span>Connected</span><b>${duration(serverNow() - r.connectedAt)}</b></div>
          <div><span>Last position</span><b>${sinceGga}</b></div>
          <div title="${esc(netTitle(r))}"><span>Connection</span><b>${netBars(r)}</b></div>
          <div title="Round-trip time between the caster and the machine${r.net?.jitterMs != null ? `, varying by about ${r.net.jitterMs} ms` : ''}"><span>Ping</span><b>${r.net?.pingMs != null ? `${r.net.pingMs} ms` : '—'}</b></div>
          <div title="Data that had to be sent to the machine again recently (lost on the way)"><span>Resent</span><b>${r.net?.lossPct != null ? `${r.net.lossPct}%` : '—'}</b></div>
        </div>
        ${r.net && r.net.bars <= 2 && r.net.reasons.length ? `<div class="warn">Weak connection: ${esc(r.net.reasons.join(', '))}</div>` : ''}
        ${profileLines(deviceOf(r.serial)?.profile)}
        ${!g ? '<div class="warn">Receiving corrections, but this rover isn\'t sending its position (GGA). Turn on "send NMEA GGA to caster" on the receiver to see it on the map.</div>' : ''}
        <div class="card-sub" style="margin-top:6px">${esc(r.protocol)} · ${esc(r.addr)}${r.agent ? ` · ${esc(r.agent)}` : ''}
          <span style="float:right"><button class="link-btn" data-history="${esc(r.serial)}">History</button><button class="link-btn danger" data-kick="${esc(r.id)}">Disconnect</button></span></div>
      </div>`;
    })
    .join(''));
}

/** Signal-style bars for a machine's connection quality, with its label. */
function netBars(r: Rover): string {
  const n = r.net;
  if (!n) return '<span class="sub">measuring…</span>';
  const bars = [1, 2, 3, 4].map((i) => `<i class="${i <= n.bars ? 'on' : ''}" style="height:${3 + i * 3}px"></i>`).join('');
  return `<span class="netbars q${n.bars}" aria-label="${esc(n.label)}">${bars}</span> ${esc(n.label)}`;
}
function netTitle(r: Rover): string {
  const n = r.net;
  if (!n) return 'Measured from the network link a few seconds after the machine connects';
  return `Measured by the caster from the network link to the machine (not the receiver's own signal reading).${n.reasons.length ? ` ${n.reasons.join('; ')}.` : ' No problems seen.'}`;
}

/** "MSM4: GPS, GLONASS, Galileo, QZSS, BeiDou" from the RTCM message numbers a base is sending. */
const MSM_SYSTEMS: [number, string][] = [[1070, 'GPS'], [1080, 'GLONASS'], [1090, 'Galileo'], [1100, 'SBAS'], [1110, 'QZSS'], [1120, 'BeiDou'], [1130, 'NavIC']];
function msmSummary(types: number[]) {
  const byLevel = new Map<number, string[]>();
  for (const t of types) {
    const sys = MSM_SYSTEMS.find(([base]) => t > base && t <= base + 7);
    if (!sys) continue;
    const level = t - sys[0];
    byLevel.set(level, [...(byLevel.get(level) || []), sys[1]]);
  }
  return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, systems]) => `MSM${lvl}: ${systems.join(', ')}`).join(' · ');
}

const FROM_DATA = new Set(['RTCM 1005/1006', 'CMR Type 1']);
/** True when the base's own data gives its position, so there is nothing to set by hand. */
const positionFromData = (m: Mountpoint) => !!m.position && (FROM_DATA.has(m.position.from) || m.position.from.startsWith('same base as'));

/**
 * The base position in the project's coordinate system: easting and northing, and the elevation in the
 * project's vertical datum when its coordinate system names a geoid model (otherwise the ellipsoidal height).
 * Falls back to latitude/longitude when the project has no coordinate system.
 */
function projectCoords(p: { lat: number; lon: number; h: number | null }) {
  const en = getEpsgCode() ? toProject(p.lon, p.lat) : null;
  const crs = getProjectCrsName() || (getEpsgCode() ? `EPSG:${getEpsgCode()}` : '');
  const geoid = projectGeoid();
  let elevation: { text: string; note: string } | null = null;
  if (p.h != null) {
    if (geoid) {
      const n = geoidSeparation(p.lat, p.lon);
      elevation = n === undefined
        ? { text: '…', note: `${geoid.datum}, from ${geoid.name}` }
        : n === null
          ? { text: `${p.h.toFixed(3)} m`, note: `ellipsoidal (${geoid.name} not available here)` }
          : { text: `${(p.h - n).toFixed(3)} m`, note: `${geoid.datum} (${geoid.name})` };
    } else {
      elevation = { text: `${p.h.toFixed(3)} m`, note: 'ellipsoidal height (no geoid in the project\'s coordinate system)' };
    }
  }
  const ll: [string, string][] = [['Latitude', `${p.lat.toFixed(8)}°`], ['Longitude', `${p.lon.toFixed(8)}°`]];
  return en && Number.isFinite(en[0])
    ? { rows: [['Easting', `${en[0].toFixed(3)} m`], ['Northing', `${en[1].toFixed(3)} m`]] as [string, string][], ll, crs, elevation }
    : { rows: [] as [string, string][], ll, crs: 'WGS84', elevation };
}

/** Position lines for the Bases tab. */
/** Drops a base position that isn't usable (missing or not a number), so one bad message can't break the page. */
function cleanMounts(list: Mountpoint[]): Mountpoint[] {
  for (const m of list) {
    const p = m.position;
    if (p && !(Number.isFinite(p.lat) && Number.isFinite(p.lon))) m.position = null;
    if (m.position && m.position.h != null && !Number.isFinite(m.position.h)) m.position.h = null;
  }
  return list;
}

function positionLines(m: Mountpoint) {
  if (!m.position) return '';
  const c = projectCoords(m.position);
  const parts = c.rows.map(([k, v]) => `${k} ${v}`);
  if (c.elevation) parts.push(`Elevation ${c.elevation.text}`);
  return `<div class="pos-lines">${parts.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
    <div class="pos-lines ll">${c.ll.map(([k, v]) => `<span>${esc(`${k} ${v}`)}</span>`).join('')}</div>
    <div class="card-sub">${esc(c.crs)}${c.elevation ? ` · elevation ${esc(c.elevation.note)}` : ''} · from ${esc(m.position.from)}${m.position.accuracy ? `, ±${esc(m.position.accuracy)}` : ''}</div>`;
}

function receiverStatus(r: Receiver) {
  if (r.reachable === null || r.reachable === undefined) return { cls: 'stale', text: 'Checking…' };
  return r.reachable ? { cls: 'online', text: 'Web UI reachable' } : { cls: 'offline', text: `Web UI not reachable${r.error ? ` (${r.error})` : ''}` };
}

/** Project members who aren't project admins get a view-only map. */
const viewOnly = () => !!app.project && !app.project.isAdmin;

function applyRole() {
  document.body.classList.toggle('view-only', viewOnly());
  if (viewOnly()) {
    const active = document.querySelector<HTMLButtonElement>('.tabs button.active');
    if (active && (active.dataset.tab === 'devices' || active.dataset.tab === 'log')) document.querySelector<HTMLButtonElement>('.tabs button[data-tab="rovers"]')?.click();
    if (dlg.open) dlg.close();
  }
}

function renderReceivers() {
  if (viewOnly()) return '';
  return `<div class="section-head"><div class="section-title">Base receivers</div><button class="link-btn" data-receiver-add>+ Add base receiver</button></div>${
    app.receivers.length ? '' : '<div class="card-sub" style="padding:0 2px 4px">Add a base receiver to open its own web interface from here.</div>'
  }${app.receivers
    .map((r) => {
      const st = receiverStatus(r);
      const mounts = app.mountpoints.filter((m) => r.mountpoints.includes(m.name));
      const online = mounts.filter((m) => m.online).length;
      return `<div class="card receiver-card">
        <div class="card-head">
          <span class="dot ${st.cls}"></span>
          <div style="min-width:0"><div class="card-title">${esc(r.name)}</div>
            <div class="card-sub">${esc([r.model, mounts.length ? `${online}/${mounts.length} streams online` : ''].filter(Boolean).join(' · '))}</div></div>
        </div>
        <div class="card-sub" style="margin-top:6px">${esc(st.text)}${r.webUrl ? ` · ${esc(r.webUrl)}` : ''}</div>
        <div class="actions">
          ${r.webUi ? `<button class="primary-btn" data-webui="${esc(r.id)}">Open web UI</button><button class="ghost-btn" data-webui-tab="${esc(r.id)}">New tab</button>` : ''}
          ${r.source === 'extension' ? `<button class="link-btn" data-receiver-edit="${esc(r.id)}" style="margin-left:auto">Edit</button>` : '<span class="card-sub" style="margin-left:auto" title="Set in the caster\'s config file">server config</span>'}
        </div>
      </div>`;
    })
    .join('')}<div class="section-title">Mountpoints</div>`;
}

/** How to point a base receiver at this project: caster address, port and the project's base password. */
function renderBaseConnection() {
  const p = app.project;
  // Only project admins are given the base password, so only they see this card
  if (!p?.isAdmin || !p.baseConnection) return '';
  const host = p.baseConnection.host || $('#casterAddr').textContent?.split(':')[0] || '';
  const pw = p.baseConnection.password;
  const open = app.baseCardOpen ?? !app.mountpoints.length;
  return `
    <details class="card connect-base"${open ? ' open' : ''}>
      <summary><b>Connect a base to this project</b><span class="hint">${esc(p.name || 'This project')}</span></summary>
      <p class="card-sub">In the base receiver's NTRIP Server (caster) output, enter these. Choose any mountpoint name: it appears here when the base connects. Bases using another project's password stay in that project.</p>
      <div class="kv"><span>Caster address</span><code>${esc(host)}</code><button class="link-btn" data-copy="${esc(host)}">Copy</button></div>
      <div class="kv"><span>Port</span><code>${p.baseConnection.port}</code><button class="link-btn" data-copy="${p.baseConnection.port}">Copy</button></div>
      <div class="kv"><span>Password</span><code>${app.showBasePassword ? esc(pw) : '••••••••••••••'}</code>
        <button class="link-btn" data-show-base-pw>${app.showBasePassword ? 'Hide' : 'Show'}</button><button class="link-btn" data-copy="${esc(pw)}">Copy</button></div>
      <div class="kv"><span>Username</span><span class="hint">Leave blank (NTRIP v2 bases may need any name)</span></div>
      <div class="actions" style="margin-top:6px"><button class="link-btn danger" data-new-base-pw>Change password…</button></div>
    </details>`;
}

// ------------------------------------------------------------------ monthly reports
const REPORT_NAME = 'NTRIP Caster Monthly Report';
const reportFileName = (mount: string, ext: string) => `${REPORT_NAME} - ${mount}.${ext}`;
let reportsBusy = false;

/** Fetches a file from the caster (with this project's sign-in). */
async function apiBlob(method: string, path: string, body?: unknown): Promise<Blob> {
  const base = settings.casterUrl.replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'X-Connect-Project': projectId(), 'X-Connect-Project-Name': encodeURIComponent(projectName()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
  return res.blob();
}

/**
 * Saves reports the caster has made into the project's top folder, oldest month first, always under the same
 * name per mountpoint so Trimble Connect keeps each month as a version. Runs when a project admin opens the extension.
 */
async function syncReports() {
  if (!app.project?.isAdmin || reportsBusy) return;
  reportsBusy = true;
  try {
    const r = (await api('GET', '/api/reports')) as unknown as { reports: typeof app.reports };
    app.reports = r.reports;
    renderBases();
    const pending = app.reports.filter((x) => !x.uploadedAt).sort((a, b) => a.month.localeCompare(b.month) || a.mount.localeCompare(b.mount));
    if (!pending.length) return;
    if (!projectFiles) {
      app.reportStatus = `${pending.length} report${pending.length === 1 ? '' : 's'} will be saved to the project when the extension is opened in Trimble Connect.`;
      renderBases();
      return;
    }
    const root = await projectFiles.root();
    for (const x of pending) {
      app.reportStatus = `Saving the ${x.month} report for ${x.mount} to the project…`;
      renderBases();
      const enc = encodeURIComponent(x.mount);
      const pdf = await apiBlob('GET', `/api/reports/${x.month}/${enc}.pdf`);
      const csv = await apiBlob('GET', `/api/reports/${x.month}/${enc}.csv`);
      await projectFiles.writeFile(root.id, reportFileName(x.mount, 'pdf'), pdf, 'application/pdf');
      await projectFiles.writeFile(root.id, reportFileName(x.mount, 'csv'), csv, 'text/csv');
      await api('POST', `/api/reports/${x.month}/${enc}/uploaded`);
      x.uploadedAt = new Date().toISOString();
    }
    app.reportStatus = `Saved ${pending.length} report${pending.length === 1 ? '' : 's'} to the project.`;
  } catch (err) {
    app.reportStatus = `Couldn't save the monthly report to the project: ${(err as Error).message}. It will be tried again next time.`;
    console.warn('[ntrip] report upload failed', err);
  } finally {
    reportsBusy = false;
    renderBases();
  }
}

function renderReports() {
  if (!app.project?.isAdmin) return '';
  const recent = [...app.reports].sort((a, b) => b.month.localeCompare(a.month) || a.mount.localeCompare(b.mount)).slice(0, 8);
  const monthName = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, 15)).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `
    <details class="card reports-card"${app.reportsOpen ? ' open' : ''}>
      <summary><b>Monthly reports</b><span class="hint">${recent.length ? esc(monthName(recent[0].month)) : 'first one after this month ends'}</span></summary>
      <p class="card-sub">A report for each mountpoint is made just after midnight on the 1st and saved in the project as <b>${esc(REPORT_NAME)} - &lt;mountpoint&gt;</b> (PDF and CSV). Each month becomes a new version of the same file, so earlier months are in the file's version history in Connect.</p>
      ${app.reportStatus ? `<p class="card-sub">${esc(app.reportStatus)}</p>` : ''}
      ${recent.length ? `<table class="mini-table"><tbody>${recent.map((r) => `<tr><td>${esc(monthName(r.month))}</td><td>${esc(r.mount)}</td>
        <td>${r.uploadedAt ? '<span class="sub">in project</span>' : '<span class="sub">waiting to be saved</span>'}</td>
        <td><button class="link-btn" data-report-pdf="${esc(r.month)}|${esc(r.mount)}">PDF</button> <button class="link-btn" data-report-csv="${esc(r.month)}|${esc(r.mount)}">CSV</button></td></tr>`).join('')}</tbody></table>` : ''}
      <div class="actions" style="margin-top:6px"><button class="link-btn" data-report-preview>Preview this month so far</button></div>
    </details>`;
}

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('#tab-bases').addEventListener('toggle', (e) => {
  const d = e.target as HTMLDetailsElement;
  if (d.classList?.contains('reports-card')) app.reportsOpen = d.open;
}, true);
$('#tab-bases').addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-report-pdf], [data-report-csv], [data-report-preview]');
  if (!t) return;
  const label = t.textContent;
  t.textContent = 'Loading…';
  try {
    if (t.hasAttribute('data-report-preview')) {
      const mount = app.mountpoints[0]?.name || '';
      saveBlob(await apiBlob('POST', '/api/reports/preview', { mount }), `${REPORT_NAME} - ${mount || 'preview'} (month to date).pdf`);
    } else {
      const csv = t.hasAttribute('data-report-csv');
      const [month, mount] = (t.dataset.reportPdf || t.dataset.reportCsv || '').split('|');
      saveBlob(await apiBlob('GET', `/api/reports/${month}/${encodeURIComponent(mount)}.${csv ? 'csv' : 'pdf'}`), `${REPORT_NAME} - ${mount} ${month}.${csv ? 'csv' : 'pdf'}`);
    }
  } catch (err) {
    alert((err as Error).message);
  } finally {
    t.textContent = label;
  }
});
// Check for a new month's reports now and then while the extension stays open
setInterval(() => { if (app.ws && app.project?.isAdmin) void syncReports(); }, 30 * 60_000);

function renderBases() {
  const el = $('#tab-bases');
  if (!app.mountpoints.length) {
    morph(el, `${renderBaseConnection()}${renderReports()}${renderReceivers()}<div class="empty">No bases in this project yet.</div>`);
    return;
  }
  morph(el, renderBaseConnection() + renderReports() + renderReceivers() + app.mountpoints
    .map(
      (m) => `
    <div class="card">
      <div class="card-head">
        <span class="dot ${m.online ? 'online' : 'offline'}"></span>
        <div style="min-width:0"><div class="card-title">${esc(m.name)}</div>
          <div class="card-sub">${esc(m.identifier)}${m.navSystem ? ` · ${esc(m.navSystem)}` : ''}</div></div>
        <div class="right">${m.auto ? '<span class="tag" title="Named by the base when it connected">Set by base</span>' : ''}<span class="tag">${esc(m.format)}</span></div>
      </div>
      <div class="grid">
        <div><span>Status</span><b>${m.online ? 'Online' : m.lastSeen ? `Last seen ${when(Date.parse(m.lastSeen))}` : 'Offline'}</b></div>
        <div><span>Data in</span><b>${m.online ? rate(m.rateBps) : '—'}</b></div>
        <div><span>Machines</span><b>${m.rovers}</b></div>
        <div><span>Up for</span><b>${m.online && m.connectedAt ? duration(serverNow() - m.connectedAt) : '—'}</b></div>
        <div><span>Total in</span><b>${m.online ? bytes(m.bytesIn) : '—'}</b></div>
        <div><span>Last data</span><b>${m.lastDataAt ? `${duration(serverNow() - m.lastDataAt)} ago` : '—'}</b></div>
      </div>
      ${positionLines(m)}
      ${m.messageTypes?.length && msmSummary(m.messageTypes) ? `<div class="card-sub" style="margin-top:6px">${esc(msmSummary(m.messageTypes))}</div>` : ''}
      ${m.messageTypes?.length ? `<div class="msgtypes">RTCM messages: ${m.messageTypes.join(', ')}</div>` : ''}
      ${m.online ? `<div class="card-sub" style="margin-top:4px">${esc(m.protocol)} from ${esc(m.addr)}</div>` : ''}
      ${m.manualPosition && m.position?.from !== 'set by hand' ? `<div class="card-sub" style="margin-top:4px">Position set by hand is on standby: the base's data gives the position while it is sending.</div>` : ''}
      ${!m.position ? `<div class="warn">No position: this base isn't on the map.${viewOnly() ? '' : ' Use <b>Set position</b> to place it.'}</div>` : ''}
      ${!positionFromData(m) || (m.auto && !m.online) ? `<div class="actions" style="margin-top:6px">
        ${!positionFromData(m) ? `<button class="link-btn" data-place="${esc(m.name)}">${m.manualPosition ? 'Change set position' : 'Set position'}</button>` : ''}
        ${m.auto && !m.online ? `<button class="link-btn danger" data-remove-mount="${esc(m.name)}">Remove mountpoint</button>` : ''}
      </div>` : ''}
    </div>`,
    )
    .join(''));
}

/** Searches and sorts logins (used by the Logins list and the export picker). */
function filterLogins(list: Device[], opts: { q: string; onlineOnly?: boolean; sortBy: string; company?: string }): Device[] {
  const live = new Set([...app.rovers.values()].map((r) => r.serial));
  const q = opts.q.trim().toLowerCase();
  const text = (d: Device) => [d.serial, d.label, d.profile?.companyName, d.profile?.operatorName, d.profile?.companyEmail, d.profile?.operatorEmail, d.profile?.companyPhone, d.profile?.operatorPhone].join(' ').toLowerCase();
  const name = (d: Device) => (d.label || d.serial).toLowerCase();
  // Empty values sort last; ties fall back to machine name
  const by = (key: (d: Device) => string) => (a: Device, b: Device) => {
    const x = key(a), y = key(b);
    if (!x !== !y) return x ? -1 : 1;
    return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) || name(a).localeCompare(name(b), undefined, { numeric: true });
  };
  const sorters: Record<string, (a: Device, b: Device) => number> = {
    name: by(name),
    serial: by((d) => d.serial),
    company: by((d) => d.profile?.companyName || ''),
    operator: by((d) => d.profile?.operatorName || ''),
    online: (a, b) => Number(live.has(b.serial)) - Number(live.has(a.serial)) || by(name)(a, b),
    newest: (a, b) => (b.created || '').localeCompare(a.created || ''),
    updated: (a, b) => (b.updated || b.created || '').localeCompare(a.updated || a.created || ''),
  };
  return list
    .filter((d) => (!q || text(d).includes(q)) && (!opts.onlineOnly || live.has(d.serial)) && (opts.company === undefined || (d.profile?.companyName || '') === opts.company))
    .sort(sorters[opts.sortBy] || sorters.name);
}

function renderDevices() {
  const checks = $('#mountChecks');
  const ticked = new Set([...checks.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value));
  checks.innerHTML = app.mountpoints
    .map((m) => `<label><input type="checkbox" value="${esc(m.name)}"${ticked.has(m.name) ? ' checked' : ''}> ${esc(m.name)} <span class="hint">${esc(m.format)}</span></label>`)
    .join('');

  const live = new Set([...app.rovers.values()].map((r) => r.serial));
  const el = $('#deviceList');
  $('#deviceTools').classList.toggle('hidden', app.devices.length < 2);
  if (!app.devices.length) {
    $('#deviceCount').textContent = '';
    el.innerHTML = '<div class="empty">No rover logins yet. Add one above using the receiver\'s serial number.</div>';
    return;
  }
  const shown = filterLogins(app.devices, {
    q: $<HTMLInputElement>('#deviceSearch').value,
    onlineOnly: $<HTMLInputElement>('#deviceOnlineOnly').checked,
    sortBy: $<HTMLSelectElement>('#deviceSort').value,
  });
  $('#deviceCount').textContent = shown.length === app.devices.length ? `${app.devices.length} logins · ${live.size} online` : `Showing ${shown.length} of ${app.devices.length}`;
  if (!shown.length) {
    el.innerHTML = '<div class="empty">No logins match.</div>';
    return;
  }
  el.innerHTML = shown
    .map(
      (d) => `
    <div class="card device-row${d.enabled ? '' : ' disabled'}" style="margin-top:8px">
      <div class="card-head">
        <span class="dot ${live.has(d.serial) ? 'online' : 'stale'}" title="${live.has(d.serial) ? 'Connected now' : 'Not connected'}"></span>
        <div style="min-width:0"><div class="card-title">${esc(d.label || d.serial)}</div>
          <div class="card-sub">${esc(d.serial)}</div></div>
        <div class="right">${d.enabled ? '' : '<span class="tag">Disabled</span>'}</div>
      </div>
      ${profileLines(d.profile)}
      <div class="card-sub" style="margin-top:4px">Mountpoints: ${d.mountpoints.length ? d.mountpoints.map(esc).join(', ') : 'all'}</div>
      <div class="actions">
        <button class="link-btn" data-history="${esc(d.serial)}">History</button>
        <button class="link-btn" data-edit="${esc(d.serial)}">Edit</button>
        <button class="link-btn" data-toggle="${esc(d.serial)}">${d.enabled ? 'Disable' : 'Enable'}</button>
        <button class="link-btn" data-email="${esc(d.serial)}">Email</button>
        <button class="link-btn danger" data-delete="${esc(d.serial)}">Delete</button>
      </div>
    </div>`,
    )
    .join('');
}

const receiverName = (id: string) => app.receivers.find((r) => r.id === id)?.name || id;
const GOOD = new Set(['rover.connected', 'source.connected', 'device.added', 'receiver.reachable']);
const BAD = new Set(['rover.rejected', 'source.rejected', 'rover.disconnected', 'source.disconnected', 'source.timeout', 'rover.overflow', 'rover.kicked', 'device.removed', 'receiver.unreachable']);
function describe(ev: LogEvent) {
  const who = ev.serial ? app.devices.find((d) => d.serial === ev.serial)?.label || ev.serial : '';
  switch (ev.type) {
    case 'rover.connected': return `${who} connected to ${ev.mount} (${ev.protocol})`;
    case 'rover.disconnected': return `${who} disconnected from ${ev.mount}`;
    case 'rover.rejected': return `Login refused for ${ev.serial} on ${ev.mount}: ${ev.reason}`;
    case 'rover.replaced': return `${who} reconnected; old session dropped`;
    case 'rover.kicked': return `${who} disconnected by ${ev.by}`;
    case 'rover.overflow': return `${who} dropped: couldn't keep up with data`;
    case 'source.connected': return `Base on ${ev.mount} online (${ev.protocol} from ${ev.addr})`;
    case 'source.disconnected': return `Base on ${ev.mount} offline`;
    case 'source.rejected': return `Base refused on ${ev.mount}: ${ev.reason}`;
    case 'source.timeout': return `Base on ${ev.mount} stopped sending data`;
    case 'source.replaced': return `Base on ${ev.mount} reconnected; old stream dropped`;
    case 'devices.imported': return `Logins imported by ${ev.by}: ${ev.added} added, ${ev.replaced} replaced, ${ev.skipped} skipped`;
    case 'devices.exported': return `${ev.count} login(s) exported by ${ev.by}`;
    case 'project.base_password_changed': return `Base password changed by ${ev.by}: bases need the new one to connect`;
    case 'project.took_over_existing': return `Existing bases, logins and receivers moved into this project (${ev.by})`;
    case 'device.added': return `Login ${ev.serial} added by ${ev.by}`;
    case 'device.updated': return `Login ${ev.serial} updated (${((ev.fields as string[]) || []).join(', ')}) by ${ev.by}`;
    case 'device.removed': return `Login ${ev.serial} deleted by ${ev.by}`;
    case 'mountpoint.removed': return `Mountpoint ${ev.mount} removed by ${ev.by}`;
    case 'mountpoint.position_changed': return `Base on ${ev.mount} moved ${ev.movedM} m${ev.heightChangeM ? ` (height ${Number(ev.heightChangeM) > 0 ? '+' : ''}${ev.heightChangeM} m)` : ''}, from its data`;
    case 'mountpoint.position_detected': return `Base position for ${ev.mount} received from its data`;
    case 'report.generated': return `Monthly report for ${ev.mount} (${ev.month}) ready`;
    case 'report.uploaded': return `Monthly report for ${ev.mount} (${ev.month}) saved to the project by ${ev.by}`;
    case 'mountpoint.position_set': return `Position of ${ev.mount} set by ${ev.by}`;
    case 'mountpoint.position_cleared': return `Set position of ${ev.mount} cleared by ${ev.by}`;
    case 'receiver.added': return `Base receiver ${ev.name || ev.receiver} added by ${ev.by}`;
    case 'receiver.updated': return `${receiverName(String(ev.receiver))} updated by ${ev.by}`;
    case 'receiver.removed': return `Base receiver ${ev.receiver} removed by ${ev.by}`;
    case 'webui.opened': return `${receiverName(String(ev.receiver))} web UI opened by ${ev.by}`;
    case 'receiver.reachable': return `${receiverName(String(ev.receiver))} web UI reachable again`;
    case 'receiver.unreachable': return `${receiverName(String(ev.receiver))} web UI not reachable${ev.reason ? ` (${ev.reason})` : ''}`;
    default: return ev.type;
  }
}
/** Whether the caster may have log entries older than the ones loaded (the log is never cleared). */
let logHasOlder = true;
function renderLog() {
  const today = new Date().toDateString();
  $('#logList').innerHTML =
    (app.log
      .slice()
      .reverse()
      .map((ev) => {
        const t = new Date(ev.time);
        const cls = GOOD.has(ev.type) ? 'ev-good' : BAD.has(ev.type) ? 'ev-bad' : '';
        const stamp = t.toDateString() === today ? t.toLocaleTimeString([], { hour12: false }) : when(t.getTime());
        return `<li><time title="${esc(t.toLocaleString())}">${esc(stamp)}</time><span class="${cls}">${esc(describe(ev))}</span></li>`;
      })
      .join('') || '<li class="empty">No events yet.</li>') +
    (app.log.length && logHasOlder ? '<li class="log-more"><button class="link-btn" id="logOlder">Show older entries</button></li>' : '');
}

$('#logList').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('#logOlder');
  if (!btn || !app.log.length) return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const { events } = (await api('GET', `/api/log?limit=200&before=${encodeURIComponent(app.log[0].time)}`)) as unknown as { events: LogEvent[] };
    logHasOlder = events.length === 200;
    app.log = [...events, ...app.log];
    renderLog();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Couldn't load (${(err as Error).message}). Try again`;
  }
});

function renderAll() {
  renderStats();
  renderMap();
  renderRovers();
  renderBases();
  renderDevices();
  renderLog();
}

// ------------------------------------------------------------------ live connection
function setPill(state: 'on' | 'off' | 'wait' | 'err', text: string) {
  const p = $('#connPill');
  p.dataset.state = state;
  p.textContent = text;
}
const token = () => app.host?.token() || settings.devToken;

function connect() {
  if (app.ws) {
    app.ws.onclose = null;
    app.ws.close();
    app.ws = null;
  }
  const base = settings.casterUrl.replace(/\/+$/, '');
  if (!base) {
    setPill('err', 'Not set up');
    openSettings();
    return;
  }
  if (!token()) {
    setPill('wait', 'Waiting for sign-in');
    return;
  }
  setPill('wait', 'Connecting…');
  const ws = new WebSocket(`${base.replace(/^http/i, 'ws')}/ws`);
  app.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: token(), project: projectId(), projectName: projectName() }));
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data as string) as CasterMessage);
  ws.onclose = (e) => {
    app.ws = null;
    if (e.code === 4003) {
      setPill('err', e.reason || 'No access to this project');
      setTimeout(connect, 60_000);
      return;
    }
    if (e.code === 4001) {
      // The token may have expired: Connect sends a fresh one on extension.accessToken, which reconnects.
      setPill('err', e.reason && e.reason !== 'Not authorised' ? e.reason : 'Not authorised');
      if (e.reason) console.warn(`[ntrip] caster refused the connection: ${e.reason}`);
      setTimeout(connect, 10_000);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** app.retry++);
    setPill('err', `Offline · retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  };
}

function handleMessage(msg: CasterMessage) {
  if (msg.type === 'hello') {
    app.retry = 0;
    setPill('on', 'Live');
    const s = msg.snapshot;
    app.serverOffset = s.serverTime - Date.now();
    $('#casterName').textContent = s.casterName;
    $('#casterAddr').textContent = s.host ? `${s.host}:${s.ntripPort}` : `port ${s.ntripPort}`;
    app.mountpoints = cleanMounts(s.mountpoints);
    app.rovers = new Map(s.rovers.map((r) => [r.id, r]));
    app.log = s.log;
    logHasOlder = s.log.length >= 100;
    app.devices = msg.devices;
    // The add form starts folded away once a project has logins, unless the person chose otherwise before
    if (store('loginFormOpen') === null) setLoginFormOpen(!app.devices.length, false);
    app.receivers = s.receivers ?? [];
    app.project = msg.project;
    applyRole();
    shareGeoWithCaster();
    void syncReports();
    if (viewOnly()) setPill('on', 'Live · view only');
    renderAll();
  } else if (msg.type === 'tick') {
    app.serverOffset = msg.serverTime - Date.now();
    app.mountpoints = cleanMounts(msg.mountpoints);
    if (msg.receivers) app.receivers = msg.receivers;
    const next = new Map<string, Rover>();
    for (const r of msg.rovers) next.set(r.id, { ...r, track: app.rovers.get(r.id)?.track || [] });
    for (const p of msg.positions) {
      const r = next.get(p.id);
      if (!r || !p.point) continue;
      const track = r.track!;
      const last = track[track.length - 1];
      if (!last || last[2] !== p.point[2]) {
        track.push(p.point);
        if (track.length > 300) track.shift();
      }
    }
    app.rovers = next;
    if (app.selected && !app.rovers.has(app.selected)) app.selected = null;
    renderStats();
    renderMap();
    renderRovers();
    renderBases();
  } else if (msg.type === 'event') {
    app.log.push(msg.event);
    renderLog();
    if (msg.event.type === 'rover.connected' || msg.event.type === 'rover.disconnected') renderDevices();
  } else if (msg.type === 'project') {
    if (app.project && !app.project.isAdmin) return;
    app.project = msg.project;
    renderBases();
  } else if (msg.type === 'receivers') {
    app.receivers = msg.receivers;
    renderBases();
    renderMap();
  } else if (msg.type === 'mountpoints') {
    app.mountpoints = cleanMounts(msg.mountpoints);
    renderBases();
    renderMap();
  } else if (msg.type === 'devices') {
    app.devices = msg.devices;
    renderDevices();
    renderRovers();
  }
}

async function api(method: string, path: string, body?: unknown) {
  const base = settings.casterUrl.replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'X-Connect-Project': projectId(),
      'X-Connect-Project-Name': encodeURIComponent(projectName()),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ UI events
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${btn.dataset.tab}`));
  }),
);

$('#tab-rovers').addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('[data-history], a')) return; // handled below / normal links
  const kick = target.closest<HTMLElement>('[data-kick]');
  if (kick) {
    e.stopPropagation();
    const r = app.rovers.get(kick.dataset.kick!);
    if (r && confirm(`Disconnect ${roverName(r)}? It will usually reconnect automatically unless its login is disabled.`)) {
      try {
        await api('POST', `/api/rovers/${encodeURIComponent(r.id)}/disconnect`);
      } catch (err) {
        alert((err as Error).message);
      }
    }
    return;
  }
  const card = target.closest<HTMLElement>('[data-rover]');
  if (card) select(card.dataset.rover!);
});

$('#trailsToggle').addEventListener('change', renderMap);
$('#labelsToggle').addEventListener('change', renderMap);
$('#fitBtn').addEventListener('click', () => fitAll(false));

const PROFILE_KEYS = ['companyName', 'companyPhone', 'companyEmail', 'operatorName', 'operatorPhone', 'operatorEmail'] as const;

// login form
const form = $<HTMLFormElement>('#deviceForm');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
// ------------------------------------------------------------------ fold away the add-login form; sort and search the list
let loginFormOpen: boolean | null = store('loginFormOpen') === null ? null : store('loginFormOpen') === '1';
function setLoginFormOpen(open: boolean, remember = true) {
  loginFormOpen = open;
  if (remember) store('loginFormOpen', open ? '1' : '0');
  $('#deviceForm').classList.toggle('collapsed', !open);
  $('#deviceFormToggle').setAttribute('aria-expanded', String(open));
}
$('#deviceFormToggle').addEventListener('click', () => setLoginFormOpen(!loginFormOpen));
for (const id of ['#deviceSort', '#deviceOnlineOnly']) {
  $(id).addEventListener('change', () => {
    store('deviceSort', $<HTMLSelectElement>('#deviceSort').value);
    renderDevices();
  });
}
$('#deviceSearch').addEventListener('input', () => renderDevices());
{
  const saved = store('deviceSort');
  if (saved && [...$<HTMLSelectElement>('#deviceSort').options].some((o) => o.value === saved)) $<HTMLSelectElement>('#deviceSort').value = saved;
}

function resetForm() {
  app.editing = null;
  form.reset();
  field('serial').disabled = false;
  field('password').required = true;
  field('password').placeholder = '';
  $('#deviceFormTitle').textContent = 'Add rover login';
  $('#deviceSubmit').textContent = 'Add login';
  $('#deviceCancel').classList.add('hidden');
  $('#mountChecks').querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.checked = false));
}
function formMsg(text: string, ok: boolean) {
  const m = $('#deviceMsg');
  m.textContent = text;
  m.className = `form-msg ${ok ? 'ok' : 'err'}`;
}
field('password').required = true;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mountpoints = [...$('#mountChecks').querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
  const profile = Object.fromEntries(PROFILE_KEYS.map((k) => [k, field(k).value.trim()]));
  const body: Record<string, unknown> = { label: field('label').value.trim(), mountpoints, enabled: field('enabled').checked, profile };
  if (field('password').value) body.password = field('password').value;
  try {
    if (app.editing) {
      await api('PATCH', `/api/devices/${encodeURIComponent(app.editing)}`, body);
      formMsg(`Saved ${app.editing}.`, true);
    } else {
      body.serial = field('serial').value.trim();
      await api('POST', '/api/devices', body);
      formMsg(`Added ${String(body.serial).toUpperCase()}. Use the serial as the NTRIP username.`, true);
    }
    resetForm();
  } catch (err) {
    formMsg((err as Error).message, false);
  }
});
$('#deviceCancel').addEventListener('click', () => {
  resetForm();
  formMsg('', true);
});

$('#deviceList').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.history) return;
  if (t.dataset.email) {
    void openLoginEmail(t.dataset.email);
    return;
  }
  const serial = t.dataset.edit || t.dataset.toggle || t.dataset.delete;
  if (!serial) return;
  const d = app.devices.find((x) => x.serial === serial);
  if (!d) return;
  if (t.dataset.edit) {
    app.editing = serial;
    field('serial').value = serial;
    field('serial').disabled = true;
    field('label').value = d.label;
    field('password').value = '';
    field('password').required = false;
    field('password').placeholder = 'Leave blank to keep current password';
    field('enabled').checked = d.enabled;
    for (const k of PROFILE_KEYS) field(k).value = d.profile?.[k] ?? '';
    $('#mountChecks').querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.checked = d.mountpoints.includes(i.value)));
    $('#deviceFormTitle').textContent = `Edit ${serial}`;
    $('#deviceSubmit').textContent = 'Save changes';
    $('#deviceCancel').classList.remove('hidden');
    formMsg('', true);
    setLoginFormOpen(true, false);
    form.scrollIntoView({ behavior: 'smooth' });
  } else if (t.dataset.toggle) {
    try {
      await api('PATCH', `/api/devices/${encodeURIComponent(serial)}`, { enabled: !d.enabled });
    } catch (err) {
      alert((err as Error).message);
    }
  } else if (t.dataset.delete) {
    if (!confirm(`Delete the login for ${d.label || serial}? The machine will be disconnected and won't be able to log in again.`)) return;
    try {
      await api('DELETE', `/api/devices/${encodeURIComponent(serial)}`);
    } catch (err) {
      alert((err as Error).message);
    }
  }
});

// ------------------------------------------------------------------ project coordinate system for the caster's monthly reports
let geoShared = '';
let geoTimer: number | undefined;
/** Tells the caster the project's coordinate system and geoid, so its reports give the base in project coordinates. */
function shareGeoWithCaster() {
  window.clearTimeout(geoTimer);
  geoTimer = window.setTimeout(() => {
    if (!app.project?.isAdmin || !app.ws) return;
    const p = projectProj4();
    const g = projectGeoid();
    const body = { crsName: getProjectCrsName() || p?.code || null, code: p?.code || null, proj4: p?.proj4 || null, geoid: g ? { name: g.name, datum: g.datum, file: g.file } : null };
    const key = JSON.stringify(body);
    if (key === geoShared || (!body.proj4 && !body.geoid)) return;
    void api('POST', '/api/project/geo', body).then(() => { geoShared = key; }).catch((err) => console.warn('[ntrip] could not share the coordinate system with the caster', err));
  }, 2000);
}
onGeoChange(shareGeoWithCaster);

// ------------------------------------------------------------------ email a login's details to its operator
const emailDlg = $<HTMLDialogElement>('#emailDlg');
$('#emailClose').addEventListener('click', () => emailDlg.close());
let emailList: LoginEmail[] = [];

const mailto = (m: LoginEmail) =>
  `mailto:${m.to.map(encodeURIComponent).join(',')}?${[m.cc.length ? `cc=${m.cc.map(encodeURIComponent).join(',')}` : '', `subject=${encodeURIComponent(m.subject)}`, `body=${encodeURIComponent(m.text.replace(/\n/g, '\r\n'))}`].filter(Boolean).join('&')}`;
const noPwNote = '<p class="warn">The caster doesn\'t have this login\'s password on record (it was set before passwords were kept for emailing), so the email asks them to use their existing password. To include it, <b>Edit</b> the login and set the password again.</p>';

async function openLoginEmail(serial: string) {
  $('#emailTitle').textContent = 'Email login details';
  $('#emailSub').textContent = serial;
  $('#emailBody').innerHTML = '<p class="empty">Loading…</p>';
  if (!emailDlg.open) emailDlg.showModal();
  try {
    const m = (await api('GET', `/api/devices/${encodeURIComponent(serial)}/credentials`)) as unknown as LoginEmail;
    emailList = [{ ...m, serial }];
    const canSend = !!app.project?.emailEnabled && m.to.length > 0;
    $('#emailBody').innerHTML = `
      ${m.to.length ? '' : '<p class="warn">This login has no operator or company email address. Add one with <b>Edit</b>, or copy the text below and send it yourself.</p>'}
      ${m.passwordOnRecord ? '' : noPwNote}
      <div class="email-meta"><span>To</span><b>${esc(m.to.join(', ') || '—')}</b>${m.cc.length ? `<span>Cc</span><b>${esc(m.cc.join(', '))}</b>` : ''}<span>Subject</span><b>${esc(m.subject)}</b></div>
      <textarea class="email-text" readonly rows="16">${esc(m.text)}</textarea>
      <div class="form-actions">
        ${canSend ? '<button class="primary-btn" id="emailSendOne">Send now</button>' : ''}
        ${m.to.length ? `<a class="${canSend ? 'ghost-btn' : 'primary-btn'} btn-link" href="${esc(mailto(m))}" target="_blank" rel="noopener">Open in email app</a>` : ''}
        <button class="ghost-btn" id="emailCopy">Copy text</button>
      </div>
      <p class="form-msg" id="emailMsg"></p>`;
  } catch (err) {
    $('#emailBody').innerHTML = `<p class="warn">${esc((err as Error).message)}</p>`;
  }
}

$('#emailAllLogins').addEventListener('click', async () => {
  $('#emailTitle').textContent = 'Email all logins';
  $('#emailSub').textContent = app.project?.name || '';
  $('#emailBody').innerHTML = '<p class="empty">Loading…</p>';
  if (!emailDlg.open) emailDlg.showModal();
  try {
    emailList = (await api('GET', '/api/devices/credentials')) as unknown as LoginEmail[];
    renderEmailAll();
  } catch (err) {
    $('#emailBody').innerHTML = `<p class="warn">${esc((err as Error).message)}</p>`;
  }
});

function renderEmailAll(sent: Map<string, string> = new Map()) {
  const withEmail = emailList.filter((m) => m.to.length);
  const noEmail = emailList.length - withEmail.length;
  const noPw = emailList.filter((m) => !m.passwordOnRecord).length;
  const canSend = !!app.project?.emailEnabled;
  $('#emailBody').innerHTML = `
    <p class="card-sub">Each enabled login gets its own email with the project, server address, port, mountpoints and formats, username and password. It goes to the operator, copied to the company contact.</p>
    ${noEmail ? `<p class="warn">${noEmail} login${noEmail === 1 ? ' has' : 's have'} no email address and will be left out.</p>` : ''}
    ${noPw ? `<p class="warn">${noPw} login${noPw === 1 ? '' : 's'} were set up before passwords were kept for emailing; their email asks them to use their existing password. Set the password again with <b>Edit</b> to include it.</p>` : ''}
    ${canSend
      ? `<div class="form-actions"><button class="primary-btn" id="emailSendAll"${withEmail.length ? '' : ' disabled'}>Send ${withEmail.length} email${withEmail.length === 1 ? '' : 's'} now</button></div>`
      : '<p class="card-sub">The caster isn\'t set up to send email, so open each one in your email app below (or ask for SMTP to be set up on the server to send them all in one go).</p>'}
    <p class="form-msg" id="emailMsg"></p>
    <table class="history-table email-table"><thead><tr><th>Login</th><th>Send to</th><th>Password</th><th></th></tr></thead><tbody>
    ${emailList
      .map((m) => {
        const status = sent.get(m.serial || '');
        return `<tr><td>${esc(m.label || m.serial)}<div class="sub">${esc(m.serial)}</div></td>
          <td>${m.to.length ? esc(m.to.join(', ')) + (m.cc.length ? `<div class="sub">cc ${esc(m.cc.join(', '))}</div>` : '') : '<span class="sub">no email address</span>'}</td>
          <td>${m.passwordOnRecord ? 'Included' : '<span class="sub">not on record</span>'}</td>
          <td>${status ? `<span class="sub">${esc(status)}</span>` : m.to.length ? `<a class="link-btn" data-opened="${esc(m.serial)}" href="${esc(mailto(m))}" target="_blank" rel="noopener">Open email</a>` : ''}</td></tr>`;
      })
      .join('')}
    </tbody></table>`;
}

$('#emailBody').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const msg = () => document.querySelector<HTMLElement>('#emailMsg');
  if (t.dataset.opened) {
    // The email app opens from the link itself; mark the row so it's easy to work down the list
    setTimeout(() => { t.replaceWith(Object.assign(document.createElement('span'), { className: 'sub', textContent: 'Opened ✓' })); }, 0);
  } else if (t.id === 'emailCopy' && emailList[0]) {
    const m = emailList[0];
    try {
      await navigator.clipboard.writeText(`To: ${m.to.join(', ')}${m.cc.length ? `\nCc: ${m.cc.join(', ')}` : ''}\nSubject: ${m.subject}\n\n${m.text}`);
      t.textContent = 'Copied';
    } catch {
      (document.querySelector('.email-text') as HTMLTextAreaElement | null)?.select();
      t.textContent = 'Press Ctrl+C to copy';
    }
  } else if (t.id === 'emailSendOne' || t.id === 'emailSendAll') {
    const serials = t.id === 'emailSendOne' ? [emailList[0].serial] : emailList.filter((m) => m.to.length).map((m) => m.serial);
    if (t.id === 'emailSendAll' && !confirm(`Send ${serials.length} email${serials.length === 1 ? '' : 's'} with login details now?`)) return;
    (t as HTMLButtonElement).disabled = true;
    t.textContent = 'Sending…';
    try {
      const r = (await api('POST', '/api/devices/email', { serials })) as unknown as { sent: { serial: string }[]; skipped: { serial: string; reason: string }[]; failed: { serial: string; reason: string }[] };
      const status = new Map<string, string>();
      for (const x of r.sent) status.set(x.serial, 'Sent ✓');
      for (const x of r.failed) status.set(x.serial, `Failed: ${x.reason}`);
      for (const x of r.skipped) status.set(x.serial, `Skipped: ${x.reason}`);
      if (t.id === 'emailSendAll') renderEmailAll(status);
      else t.textContent = r.sent.length ? 'Sent ✓' : 'Not sent';
      const m = msg();
      if (m) {
        m.textContent = `${r.sent.length} sent${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.${r.failed[0] ? ` ${r.failed[0].reason}` : ''}`;
        m.className = `form-msg ${r.failed.length ? 'err' : 'ok'}`;
      }
    } catch (err) {
      (t as HTMLButtonElement).disabled = false;
      t.textContent = 'Try again';
      const m = msg();
      if (m) { m.textContent = (err as Error).message; m.className = 'form-msg err'; }
    }
  }
});

// ------------------------------------------------------------------ base receiver web UI
const webuiPanel = $('#webuiPanel');
const webuiFrame = $<HTMLIFrameElement>('#webuiFrame');
const webuiMsg = $('#webuiMsg');

/** A one-time sign-in link (valid 60 s) to the receiver's web interface through the caster. */
async function webUiLink(id: string): Promise<string> {
  const reply = (await api('POST', `/api/receivers/${encodeURIComponent(id)}/webui`)) as { url?: string };
  if (!reply.url) throw new Error('The caster did not return a link');
  return reply.url;
}

function webuiMessage(text: string | null) {
  webuiMsg.classList.toggle('hidden', !text);
  webuiMsg.textContent = text ?? '';
}

async function openWebUi(id: string) {
  const r = app.receivers.find((x) => x.id === id);
  if (!r) return;
  app.webUiOpen = id;
  popup.remove();
  $('#webuiTitle').textContent = r.name;
  $('#webuiSub').textContent = [r.model, r.mountpoints.join(' · ')].filter(Boolean).join(' — ');
  webuiPanel.classList.remove('hidden');
  webuiFrame.src = 'about:blank';
  webuiMessage(r.reachable === false ? `Connecting to ${r.name}… (the caster couldn't reach it on its last check)` : `Connecting to ${r.name}…`);
  try {
    const url = await webUiLink(id);
    if (app.webUiOpen !== id) return;
    webuiFrame.onload = () => webuiMessage(null);
    webuiFrame.src = url;
  } catch (err) {
    webuiMessage(`Couldn't open the web UI: ${(err as Error).message}`);
  }
}

async function openWebUiTab(id: string) {
  // Open the tab straight away (inside the click) so popup blockers allow it, then point it at the sign-in link.
  const tab = window.open('about:blank', '_blank');
  try {
    const url = await webUiLink(id);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) {
    tab?.close();
    alert(`Couldn't open the web UI: ${(err as Error).message}`);
  }
}

function closeWebUi() {
  app.webUiOpen = null;
  webuiPanel.classList.add('hidden');
  webuiFrame.src = 'about:blank';
  webuiMessage(null);
}

$('#webuiClose').addEventListener('click', closeWebUi);
$('#webuiReload').addEventListener('click', () => app.webUiOpen && void openWebUi(app.webUiOpen));
$('#webuiNewTab').addEventListener('click', () => app.webUiOpen && void openWebUiTab(app.webUiOpen));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.webUiOpen && !(document.querySelector('dialog[open]'))) closeWebUi();
});
// Buttons in the Bases tab and in base markers' popups
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-webui], [data-webui-tab]');
  if (!t) return;
  if (t.dataset.webui) void openWebUi(t.dataset.webui);
  else if (t.dataset.webuiTab) void openWebUiTab(t.dataset.webuiTab);
});

// "Connect a base to this project" card
$('#tab-bases').addEventListener('toggle', (e) => {
  const d = e.target as HTMLDetailsElement;
  if (d.classList?.contains('connect-base')) app.baseCardOpen = d.open;
}, true);
$('#tab-bases').addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-copy], [data-show-base-pw], [data-new-base-pw]');
  if (!t) return;
  if (t.dataset.copy !== undefined) {
    try {
      await navigator.clipboard.writeText(t.dataset.copy);
      t.textContent = 'Copied';
    } catch {
      t.textContent = 'Copy blocked';
    }
    setTimeout(() => { t.textContent = 'Copy'; }, 1500);
  } else if (t.hasAttribute('data-show-base-pw')) {
    app.showBasePassword = !app.showBasePassword;
    renderBases();
  } else if (t.hasAttribute('data-new-base-pw')) {
    if (!confirm('Give this project a new base password?\n\nBases using the current password will be refused the next time they connect, until you enter the new one in each receiver.')) return;
    try {
      app.project = (await api('POST', '/api/project/base-password')) as unknown as ProjectInfo;
      app.showBasePassword = true;
      renderBases();
    } catch (err) {
      alert((err as Error).message);
    }
  }
});

// ------------------------------------------------------------------ export / import logins between projects
function safeFileName(s: string) {
  return s.replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';
}

// Export picker: choose which logins go in the file
const exportDlg = $<HTMLDialogElement>('#exportDlg');
const exportPicked = new Set<string>();
$('#exportLogins').addEventListener('click', () => {
  if (!app.devices.length) {
    alert('This project has no logins to export yet.');
    return;
  }
  exportPicked.clear();
  for (const d of app.devices) exportPicked.add(d.serial);
  $<HTMLInputElement>('#exportSearch').value = '';
  const companies = [...new Set(app.devices.map((d) => d.profile?.companyName || ''))].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
  $('#exportCompany').innerHTML = `<option value="*">All companies</option>${companies.map((c) => `<option value="${esc(c)}">${c ? esc(c) : '(no company)'}</option>`).join('')}`;
  $<HTMLSelectElement>('#exportSort').value = $<HTMLSelectElement>('#deviceSort').value;
  renderExportList();
  if (!exportDlg.open) exportDlg.showModal();
});

function exportShown(): Device[] {
  const company = $<HTMLSelectElement>('#exportCompany').value;
  return filterLogins(app.devices, { q: $<HTMLInputElement>('#exportSearch').value, sortBy: $<HTMLSelectElement>('#exportSort').value, company: company === '*' ? undefined : company });
}

function renderExportList() {
  const shown = exportShown();
  const live = new Set([...app.rovers.values()].map((r) => r.serial));
  $('#exportList').innerHTML = shown.length
    ? shown
        .map(
          (d) => `<label class="pick-row"><input type="checkbox" data-pick="${esc(d.serial)}"${exportPicked.has(d.serial) ? ' checked' : ''}>
        <span class="dot ${live.has(d.serial) ? 'online' : 'stale'}"></span>
        <span class="pick-main"><b>${esc(d.label || d.serial)}</b><span class="sub">${esc(d.serial)}${d.enabled ? '' : ' · disabled'}</span></span>
        <span class="pick-side">${esc(d.profile?.companyName || '')}<span class="sub">${esc(d.profile?.operatorName || '')}</span></span></label>`,
        )
        .join('')
    : '<div class="empty">No logins match.</div>';
  const shownPicked = shown.filter((d) => exportPicked.has(d.serial)).length;
  $('#exportCount').textContent = `${exportPicked.size} of ${app.devices.length} selected${shown.length !== app.devices.length ? ` · ${shownPicked} of ${shown.length} shown` : ''}`;
  const go = $<HTMLButtonElement>('#exportGo');
  go.disabled = !exportPicked.size;
  go.textContent = `Export ${exportPicked.size} login${exportPicked.size === 1 ? '' : 's'}`;
  const all = $<HTMLInputElement>('#exportAllShown');
  all.checked = shown.length > 0 && shownPicked === shown.length;
  all.indeterminate = shownPicked > 0 && shownPicked < shown.length;
}

$('#exportSearch').addEventListener('input', renderExportList);
$('#exportSort').addEventListener('change', renderExportList);
$('#exportCompany').addEventListener('change', renderExportList);
$('#exportList').addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.dataset.pick) return;
  if (box.checked) exportPicked.add(box.dataset.pick);
  else exportPicked.delete(box.dataset.pick);
  renderExportList();
});
$('#exportAllShown').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  for (const d of exportShown()) on ? exportPicked.add(d.serial) : exportPicked.delete(d.serial);
  renderExportList();
});
$('#exportNone').addEventListener('click', () => {
  exportPicked.clear();
  renderExportList();
});
$('#exportCancel').addEventListener('click', () => exportDlg.close());

$('#exportGo').addEventListener('click', async () => {
  const go = $<HTMLButtonElement>('#exportGo');
  go.disabled = true;
  try {
    const data = (await api('POST', '/api/devices/export', { serials: [...exportPicked] })) as unknown as LoginExport;
    if (!data.logins.length) {
      alert('None of the selected logins could be exported.');
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ntrip-logins-${safeFileName(app.project?.name || projectId())}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    exportDlg.close();
  } catch (err) {
    alert(`Could not export: ${(err as Error).message}`);
  } finally {
    go.disabled = !exportPicked.size;
  }
});

$('#importLogins').addEventListener('click', () => $<HTMLInputElement>('#importFile').click());
$<HTMLInputElement>('#importFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as LoginExport;
    if (data?.format !== 'connect-ntrip-logins' || !Array.isArray(data.logins)) throw new Error('This is not a logins file exported from Connect-NTRIP');
    app.pendingImport = data;
  } catch (err) {
    app.pendingImport = null;
    alert((err as Error).message.startsWith('This is') ? (err as Error).message : 'Could not read that file');
  }
  renderImport();
});

function renderImport() {
  const el = $('#importPreview');
  const data = app.pendingImport;
  el.classList.toggle('hidden', !data);
  if (!data) {
    el.innerHTML = '';
    return;
  }
  const here = new Set(app.devices.map((d) => d.serial.toUpperCase()));
  const clash = data.logins.filter((l) => here.has(String(l.serial).toUpperCase()));
  el.innerHTML = `
    <h3>Import logins</h3>
    <p class="card-sub">${data.logins.length} login(s) from <b>${esc(data.fromProject)}</b>, exported ${esc(when(Date.parse(data.exportedAt)))}.
      Passwords come across unchanged, so machines keep their existing password.</p>
    <ul class="import-list">${data.logins
      .map((l) => `<li>${esc(l.label || l.serial)} <span class="hint">${esc(l.serial)}${l.profile?.companyName ? ` · ${esc(l.profile.companyName)}` : ''}${here.has(String(l.serial).toUpperCase()) ? ' · already in this project' : ''}</span></li>`)
      .join('')}</ul>
    ${clash.length ? `<label class="inline"><input type="checkbox" id="importReplace"> Replace the ${clash.length} login(s) already in this project</label>` : ''}
    <p class="card-sub">Allowed mountpoints are not copied: imported logins can use every base in this project until you limit them.</p>
    <div class="form-actions">
      <button type="button" class="primary-btn" id="importGo">Import</button>
      <button type="button" class="ghost-btn" id="importCancel">Cancel</button>
    </div>
    <p class="form-msg" id="importMsg"></p>`;
}

$('#importPreview').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'importCancel') {
    app.pendingImport = null;
    renderImport();
  } else if (t.id === 'importGo' && app.pendingImport) {
    const replace = !!document.querySelector<HTMLInputElement>('#importReplace')?.checked;
    (t as HTMLButtonElement).disabled = true;
    try {
      const r = (await api('POST', '/api/devices/import', { logins: app.pendingImport.logins, replace })) as unknown as { added: number; replaced: number; skipped: number; errors: string[] };
      app.pendingImport = null;
      renderImport();
      formMsg(`Imported: ${r.added} added${r.replaced ? `, ${r.replaced} replaced` : ''}${r.skipped ? `, ${r.skipped} already here (kept)` : ''}${r.errors.length ? `. ${r.errors.length} could not be imported: ${r.errors.slice(0, 3).join('; ')}` : ''}`, !r.errors.length);
    } catch (err) {
      $('#importMsg').textContent = (err as Error).message;
      (t as HTMLButtonElement).disabled = false;
    }
  }
});

// Mountpoints a base named itself can be removed once that base has stopped sending to them
document.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-mount]');
  if (!t?.dataset.removeMount) return;
  const name = t.dataset.removeMount;
  if (!confirm(`Remove mountpoint ${name}? If the base connects to it again it will be created again.`)) return;
  try {
    await api('DELETE', `/api/mountpoints/${encodeURIComponent(name)}`);
    app.mountpoints = app.mountpoints.filter((m) => m.name !== name);
    renderBases();
    renderDevices();
    renderMap();
  } catch (err) {
    alert((err as Error).message);
  }
});

// ------------------------------------------------------------------ set base position by hand
const placePanel = $('#placePanel');
const placeA = $<HTMLInputElement>('#placeA');
const placeB = $<HTMLInputElement>('#placeB');
const placeH = $<HTMLInputElement>('#placeH');
let placing: { mounts: string[]; marker: maplibregl.Marker | null } | null = null;

const placeModeEN = () => (document.querySelector<HTMLInputElement>('input[name=placeMode]:checked')?.value ?? 'll') === 'en';
function placeMsg(text: string, ok = false) {
  const m = $('#placeMsg');
  m.textContent = text;
  m.className = `form-msg ${ok ? 'ok' : 'err'}`;
}
function setPlaceLabels() {
  const en = placeModeEN();
  $('#placeLabelA').textContent = en ? 'Easting (m)' : 'Latitude';
  $('#placeLabelB').textContent = en ? 'Northing (m)' : 'Longitude';
  placeA.placeholder = en ? '320785.37' : '-37.8136';
  placeB.placeholder = en ? '5812835.75' : '144.9631';
}
/** The project's coordinate system, when Connect gives one, lets positions be typed as easting/northing. */
function refreshPlaceModes() {
  const crs = getEpsgCode();
  $('#placeMode').hidden = !crs;
  $('#placeCrsName').textContent = crs ? `Easting / Northing (${getProjectCrsName() || crs})` : 'Easting / Northing';
  if (!crs) (document.querySelector<HTMLInputElement>('input[name=placeMode][value=ll]')!).checked = true;
  setPlaceLabels();
}
onGeoChange(refreshPlaceModes);

/** Reads the typed fields as [lon, lat]; a pasted "lat, lon" in the first box is split too. */
function placeFromInputs(): [number, number] | null {
  let a = placeA.value.trim();
  let b = placeB.value.trim();
  const both = a.split(/[\s,;]+/).filter(Boolean);
  if (!b && both.length === 2) {
    [a, b] = both;
    placeA.value = a;
    placeB.value = b;
  }
  const x = Number(a), y = Number(b);
  if (!a || !b || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (placeModeEN()) {
    const ll = fromProject(x, y);
    return ll && Number.isFinite(ll[0]) && Math.abs(ll[1]) <= 90 ? ll : null;
  }
  return Math.abs(x) <= 90 && Math.abs(y) <= 180 ? [y, x] : null;
}
function writeInputs(lon: number, lat: number) {
  if (placeModeEN()) {
    const en = toProject(lon, lat);
    if (en) {
      placeA.value = en[0].toFixed(3);
      placeB.value = en[1].toFixed(3);
      return;
    }
  }
  placeA.value = lat.toFixed(7);
  placeB.value = lon.toFixed(7);
}
function placePin(lon: number, lat: number) {
  if (!placing) return;
  if (!placing.marker) {
    const el = document.createElement('div');
    el.innerHTML = `<svg class="place-pin" viewBox="0 0 26 34"><path d="M13 1C6.4 1 1 6.3 1 12.8 1 21.6 13 33 13 33s12-11.4 12-20.2C25 6.3 19.6 1 13 1Z" fill="${css('--base')}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4.5" fill="#fff"/></svg>`;
    placing.marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat([lon, lat]).addTo(map);
    placing.marker.on('drag', () => {
      const p = placing?.marker?.getLngLat();
      if (p) writeInputs(p.lng, p.lat);
    });
  } else {
    placing.marker.setLngLat([lon, lat]);
  }
}

function openPlace(name: string, group?: string[]) {
  closePlace();
  const m = app.mountpoints.find((x) => x.name === name);
  if (!m) return;
  closeWebUi();
  popup.remove();
  placing = { mounts: [name], marker: null };
  $('#placeTitle').textContent = `Set position — ${name}`;
  refreshPlaceModes();
  placeH.value = m.manualPosition?.h != null ? String(m.manualPosition.h) : '';
  // Other mountpoints of the same base can take the same position: same receiver, same address, or the same marker
  const receiver = app.receivers.find((r) => r.mountpoints.includes(name));
  const sameBase = (o: Mountpoint) =>
    (group?.includes(o.name) ?? false) || (receiver?.mountpoints.includes(o.name) ?? false) ||
    (!!m.addr && !!o.addr && o.addr.replace(/:\d+$/, '') === m.addr.replace(/:\d+$/, ''));
  const others = app.mountpoints.filter((o) => o.name !== name);
  $('#placeApply').innerHTML = others.length
    ? `<span class="k">Also set for:</span>${others
        .map((o) => `<label><input type="checkbox" value="${esc(o.name)}"${sameBase(o) ? ' checked' : ''}> ${esc(o.name)}</label>`)
        .join('')}`
    : '';
  $('#placeClear').classList.toggle('hidden', !m.manualPosition);
  placeMsg('');
  const start = m.manualPosition || m.position;
  if (start) {
    writeInputs(start.lon, start.lat);
    placePin(start.lon, start.lat);
    map.easeTo({ center: [start.lon, start.lat], zoom: Math.max(map.getZoom(), 16), duration: 400 });
  } else {
    placeA.value = '';
    placeB.value = '';
  }
  placePanel.classList.remove('hidden');
  mapEl.parentElement!.classList.add('placing');
  (start ? placeH : placeA).focus();
}

function closePlace() {
  placing?.marker?.remove();
  placing = null;
  placePanel.classList.add('hidden');
  mapEl.parentElement?.classList.remove('placing');
}

map.on('click', (e) => {
  if (!placing) return;
  writeInputs(e.lngLat.lng, e.lngLat.lat);
  placePin(e.lngLat.lng, e.lngLat.lat);
  placeMsg('');
});
for (const input of [placeA, placeB]) {
  input.addEventListener('change', () => {
    const ll = placeFromInputs();
    if (ll) {
      placePin(ll[0], ll[1]);
      map.easeTo({ center: ll, duration: 300 });
      placeMsg('');
    } else if (placeA.value && placeB.value) {
      placeMsg(placeModeEN() ? 'Those don\'t look like easting and northing in the project\'s coordinate system.' : 'Latitude must be -90 to 90 and longitude -180 to 180, in decimal degrees.');
    }
  });
}
document.querySelectorAll<HTMLInputElement>('input[name=placeMode]').forEach((r) =>
  r.addEventListener('change', () => {
    const p = placing?.marker?.getLngLat();
    setPlaceLabels();
    if (p) writeInputs(p.lng, p.lat);
    else {
      placeA.value = '';
      placeB.value = '';
    }
  }),
);

$('#placeClose').addEventListener('click', closePlace);
$('#placeSave').addEventListener('click', async () => {
  if (!placing) return;
  const ll = placeFromInputs() ?? (placing.marker ? ([placing.marker.getLngLat().lng, placing.marker.getLngLat().lat] as [number, number]) : null);
  if (!ll) return placeMsg('Click the map to place the base, or type its coordinates.');
  const h = placeH.value.trim();
  if (h && !Number.isFinite(Number(h))) return placeMsg('Height must be a number of metres, or left empty.');
  const names = [placing.mounts[0], ...[...$('#placeApply').querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)];
  $<HTMLButtonElement>('#placeSave').disabled = true;
  try {
    for (const n of names) await api('PUT', `/api/mountpoints/${encodeURIComponent(n)}/position`, { lat: ll[1], lon: ll[0], h: h === '' ? null : Number(h) });
    closePlace();
    app.fitted = true;
  } catch (err) {
    placeMsg(`Couldn't save: ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('#placeSave').disabled = false;
  }
});
$('#placeClear').addEventListener('click', async () => {
  if (!placing) return;
  const name = placing.mounts[0];
  if (!confirm(`Clear the position set by hand for ${name}?`)) return;
  try {
    await api('DELETE', `/api/mountpoints/${encodeURIComponent(name)}/position`);
    closePlace();
  } catch (err) {
    placeMsg(`Couldn't clear: ${(err as Error).message}`);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && placing && !document.querySelector('dialog[open]')) closePlace();
});
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-place]');
  if (!t?.dataset.place) return;
  e.stopPropagation();
  openPlace(t.dataset.place, t.dataset.placeGroup?.split('|'));
});

// ------------------------------------------------------------------ add / edit base receivers
const receiverDlg = $<HTMLDialogElement>('#receiverDlg');
const receiverForm = $<HTMLFormElement>('#receiverForm');
const rfield = (name: string) => receiverForm.elements.namedItem(name) as HTMLInputElement;
let editingReceiver: string | null = null;

function openReceiverForm(id: string | null) {
  const r = id ? app.receivers.find((x) => x.id === id) : null;
  editingReceiver = r?.id ?? null;
  receiverForm.reset();
  $('#receiverTitle').textContent = r ? `Edit ${r.name}` : 'Add base receiver';
  rfield('rname').value = r?.name ?? '';
  rfield('rmodel').value = r?.model ?? '';
  rfield('rurl').value = r?.webUrl ?? '';
  const ticked = new Set(r?.mountpoints ?? []);
  $('#receiverMounts').innerHTML = app.mountpoints.length
    ? app.mountpoints.map((m) => `<label><input type="checkbox" value="${esc(m.name)}"${ticked.has(m.name) ? ' checked' : ''}> ${esc(m.name)} <span class="hint">${esc(m.format)}</span></label>`).join('')
    : '<span class="hint">No mountpoints yet. Connect the base to the caster first, then tick its mountpoints here.</span>';
  $('#receiverRemove').classList.toggle('hidden', !r);
  $('#receiverMsg').textContent = '';
  receiverDlg.showModal();
}

receiverForm.addEventListener('submit', async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== 'save') return;
  e.preventDefault();
  const body: Record<string, unknown> = {
    name: rfield('rname').value.trim(),
    model: rfield('rmodel').value.trim(),
    webUrl: rfield('rurl').value.trim(),
    mountpoints: [...$('#receiverMounts').querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value),
  };
  const msg = $('#receiverMsg');
  $<HTMLButtonElement>('#receiverSave').disabled = true;
  try {
    const saved = (await api(editingReceiver ? 'PATCH' : 'POST', editingReceiver ? `/api/receivers/${encodeURIComponent(editingReceiver)}` : '/api/receivers', body)) as unknown as Receiver;
    app.receivers = [...app.receivers.filter((x) => x.id !== saved.id), saved];
    receiverDlg.close();
    renderBases();
  } catch (err) {
    msg.textContent = (err as Error).message;
    msg.className = 'form-msg err';
  } finally {
    $<HTMLButtonElement>('#receiverSave').disabled = false;
  }
});
$('#receiverRemove').addEventListener('click', async () => {
  const r = app.receivers.find((x) => x.id === editingReceiver);
  if (!r || !confirm(`Remove ${r.name}? Its corrections keep working; only the web UI link is removed.`)) return;
  try {
    await api('DELETE', `/api/receivers/${encodeURIComponent(r.id)}`);
    app.receivers = app.receivers.filter((x) => x.id !== r.id);
    receiverDlg.close();
    renderBases();
  } catch (err) {
    $('#receiverMsg').textContent = (err as Error).message;
    $('#receiverMsg').className = 'form-msg err';
  }
});
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-receiver-add], [data-receiver-edit]');
  if (!t) return;
  openReceiverForm(t.dataset.receiverEdit ?? null);
});

// ------------------------------------------------------------------ online history
const historyDlg = $<HTMLDialogElement>('#historyDlg');
let historySerial: string | null = null;
let historyData: HistoryReply | null = null;

const hms = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s2).padStart(2, '0')}s` : `${s2}s`;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function fixBar(f: SessionRecord['fixSec']) {
  const total = f.fixed + f.float + f.other + f.none;
  if (!total) return '<span class="sub">no position sent</span>';
  const seg = (v: number, colour: string, label: string) => (v ? `<i style="width:${(v / total) * 100}%;background:${colour}" title="${label}: ${hms(v)} (${Math.round((v / total) * 100)}%)"></i>` : '');
  return `<div class="fixbar">${seg(f.fixed, css('--q4'), 'RTK fixed')}${seg(f.float, css('--q5'), 'Float')}${seg(f.other, css('--q2'), 'DGPS/autonomous')}${seg(f.none, css('--stale'), 'No position')}</div>
    <div class="sub">${Math.round((f.fixed / total) * 100)}% fixed</div>`;
}

function renderHistory() {
  const data = historyData;
  if (!data) return;
  const d = data.device;
  const p = d.profile;
  $('#historyTitle').textContent = `${d.label || d.serial} — online history`;
  $('#historySub').textContent = `${d.serial}${d.mountpoints.length ? ` · ${d.mountpoints.join(', ')}` : ''}${d.enabled ? '' : ' · login disabled'}`;
  const contact = (k: string, name: string, phone: string, email: string) =>
    `<div class="contact-card"><div class="k">${k}</div>${name ? `<b>${esc(name)}</b><br>` : '<span class="sub">No name</span><br>'}${phone ? `${tel(phone)}<br>` : ''}${email ? mail(email) : ''}</div>`;
  $('#historyContacts').innerHTML = contact('Company', p.companyName, p.companyPhone, p.companyEmail) + contact('Operator', p.operatorName, p.operatorPhone, p.operatorEmail);

  const showRejected = $<HTMLInputElement>('#historyRejected').checked;
  const sessions = data.records.filter((r): r is SessionRecord => r.type === 'session');
  const rejected = data.records.filter((r) => r.type === 'rejected');
  const online = sessions.reduce((a, r) => a + r.durationSec, 0) + data.live.reduce((a, r) => a + (serverNow() - r.connectedAt) / 1000, 0);
  const fix = sessions.reduce((a, r) => ({ fixed: a.fixed + r.fixSec.fixed, float: a.float + r.fixSec.float, other: a.other + r.fixSec.other, none: a.none + r.fixSec.none }), { fixed: 0, float: 0, other: 0, none: 0 });
  const totalBytes = sessions.reduce((a, r) => a + r.bytes, 0) + data.live.reduce((a, r) => a + r.bytesOut, 0);
  const lastSeen = data.live.length ? 'Online now' : sessions[0] ? when(sessions[0].end) : '—';
  $('#historyStats').innerHTML = `
    <div class="stat"><b>${sessions.length + data.live.length}</b><span>Sessions</span></div>
    <div class="stat"><b>${hms(online)}</b><span>Time online</span></div>
    <div class="stat"><b>${bytes(totalBytes)}</b><span>Corrections sent</span></div>
    <div class="stat"><span>Fix quality</span>${fixBar(fix)}</div>
    <div class="stat"><b>${rejected.length}</b><span>Refused logins</span></div>
    <div class="stat"><b style="font-size:13px">${esc(lastSeen)}</b><span>Last online</span></div>`;

  const rows: string[] = [];
  for (const r of data.live) {
    rows.push(`<tr class="live"><td class="num">${when(r.connectedAt)}<div class="sub">online now</div></td><td class="num">${hms((serverNow() - r.connectedAt) / 1000)}</td><td>${esc(r.mount)}<div class="sub hide-sm">${esc(r.protocol)}</div></td>
      <td>${r.gga ? esc(r.gga.fix) : '<span class="sub">no position sent</span>'}</td><td class="num">${bytes(r.bytesOut)}</td><td class="hide-sm">${esc(r.addr)}</td><td>Connected</td>
      <td>${r.gga ? `<button class="link-btn" data-trail-start="${r.connectedAt}">Show</button>` : ''}</td></tr>`);
  }
  for (const r of data.records as HistoryRecord[]) {
    if (r.type === 'rejected') {
      if (!showRejected) continue;
      rows.push(`<tr class="rejected"><td class="num">${when(r.time)}</td><td></td><td>${esc(r.mount)}</td><td colspan="2">Login refused</td><td class="hide-sm">${esc(r.addr)}</td><td>${esc(r.reason)}</td><td></td></tr>`);
    } else {
      rows.push(`<tr><td class="num">${when(r.start)}<div class="sub">to ${sameDay(r.start, r.end) ? clock(r.end) : when(r.end)}</div></td><td class="num">${hms(r.durationSec)}</td>
        <td>${esc(r.mount)}<div class="sub hide-sm">${esc(r.protocol)}</div></td><td>${fixBar(r.fixSec)}</td><td class="num">${bytes(r.bytes)}</td>
        <td class="hide-sm">${esc(r.addr)}${r.agent ? `<div class="sub">${esc(r.agent)}</div>` : ''}</td><td>${esc(r.endReason)}</td>
        <td>${r.trailPoints ? `<button class="link-btn" data-trail-start="${r.start}" title="${r.trailPoints} points">Show</button>` : `<span class="sub">${r.sentPosition ? 'not kept' : '—'}</span>`}</td></tr>`);
    }
  }
  const range = data.days ? `the last ${data.days === 1 ? '24 hours' : `${data.days} days`}` : 'the history kept';
  $('#historyTable').innerHTML = `<thead><tr><th>Connected</th><th>Duration</th><th>Mountpoint</th><th>Fix</th><th>Data</th><th class="hide-sm">From</th><th>Ended</th><th>Trail</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="8" class="empty">No connections in ${range}.</td></tr>`}</tbody>`;
}

async function loadHistory() {
  if (!historySerial) return;
  const days = $<HTMLSelectElement>('#historyRange').value;
  $('#historyTable').innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    historyData = (await api('GET', `/api/devices/${encodeURIComponent(historySerial)}/history?days=${days}`)) as unknown as HistoryReply;
    renderHistory();
  } catch (err) {
    $('#historyTable').innerHTML = `<tbody><tr><td class="empty">Couldn't load the history: ${esc((err as Error).message)}</td></tr></tbody>`;
  }
}

function openHistory(serial: string) {
  historySerial = serial;
  historyData = null;
  const d = deviceOf(serial);
  $('#historyTitle').textContent = `${d?.label || serial} — online history`;
  $('#historySub').textContent = serial;
  $('#historyContacts').innerHTML = '';
  $('#historyStats').innerHTML = '';
  if (!historyDlg.open) historyDlg.showModal();
  void loadHistory();
}

function historyCsv() {
  const data = historyData;
  if (!data) return;
  const q = (v: unknown) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const p = data.device.profile;
  const head = ['Serial', 'Machine', 'Company', 'Company phone', 'Company email', 'Operator', 'Operator phone', 'Operator email', 'Type', 'Start (UTC)', 'End (UTC)', 'Duration (s)', 'Mountpoint', 'Protocol', 'Address', 'Receiver software', 'Data sent (bytes)', 'RTK fixed (s)', 'Float (s)', 'Other fix (s)', 'No position (s)', 'Ended / reason', 'First lat', 'First lon', 'Last lat', 'Last lon'];
  const who = [data.device.serial, data.device.label, p.companyName, p.companyPhone, p.companyEmail, p.operatorName, p.operatorPhone, p.operatorEmail];
  const lines = [head.map(q).join(',')];
  for (const r of data.live) lines.push([...who, 'online now', iso(r.connectedAt), '', Math.round((serverNow() - r.connectedAt) / 1000), r.mount, r.protocol, r.addr, r.agent, r.bytesOut, '', '', '', '', 'still connected', '', '', r.gga?.lat ?? '', r.gga?.lon ?? ''].map(q).join(','));
  for (const r of data.records) {
    if (r.type === 'rejected') lines.push([...who, 'login refused', iso(r.time), '', '', r.mount, '', r.addr, r.agent ?? '', '', '', '', '', '', r.reason, '', '', '', ''].map(q).join(','));
    else lines.push([...who, 'session', iso(r.start), iso(r.end), r.durationSec, r.mount, r.protocol, r.addr, r.agent ?? '', r.bytes, r.fixSec.fixed, r.fixSec.float, r.fixSec.other, r.fixSec.none, r.endReason, r.firstPos?.[0] ?? '', r.firstPos?.[1] ?? '', r.lastPos?.[0] ?? '', r.lastPos?.[1] ?? ''].map(q).join(','));
  }
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.device.serial}-online-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#historyClose').addEventListener('click', () => historyDlg.close());
$('#historyRange').addEventListener('change', () => void loadHistory());
$('#historyRejected').addEventListener('change', renderHistory);
$('#historyCsv').addEventListener('click', historyCsv);

// ------------------------------------------------------------------ trails from a login's history
interface TrailPoint { lng: number; lat: number; t: number; q: number; who: string }
/** Points of the trails on the map (history and live) that hovering can show the time of. */
let historyTrail: { serial: string; who: string; sessions: number; from: number; to: number; points: TrailPoint[] } | null = null;

async function showTrails(starts: number[]) {
  const data = historyData;
  if (!data || !starts.length) return;
  const serial = data.device.serial;
  const who = data.device.label || serial;
  const btn = $<HTMLButtonElement>('#historyTrailsAll');
  btn.disabled = true;
  btn.textContent = 'Loading trails…';
  try {
    const replies = await Promise.all(
      starts.map((s) => api('GET', `/api/devices/${encodeURIComponent(serial)}/track?start=${s}`) as unknown as Promise<{ points: [number, number, number, number][] }>),
    );
    const sessions = replies.map((r) => r.points.map(([lat, lon, t, q]) => ({ lat, lng: lon, t, q, who })));
    const points = sessions.flat();
    if (!points.length) {
      alert('No trail was kept for these sessions (the machine sent no positions).');
      return;
    }
    historyTrail = { serial, who, sessions: sessions.filter((s) => s.length).length, from: Math.min(...points.map((p) => p.t)), to: Math.max(...points.map((p) => p.t)), points };
    drawHistoryTrail(sessions);
    historyDlg.close();
    const b = new maplibregl.LngLatBounds();
    for (const p of points) b.extend([p.lng, p.lat]);
    app.fitted = true;
    map.fitBounds(b, { padding: { top: 110, bottom: 70, left: 60, right: 60 }, maxZoom: 19, duration: 600 });
  } catch (err) {
    alert(`Couldn't load the trail: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Show trails on map';
  }
}

function drawHistoryTrail(sessions: TrailPoint[][]) {
  const features: GeoJSON.Feature[] = [];
  for (const pts of sessions) {
    if (!pts.length) continue;
    // One line per run of the same fix quality, so the colour shows where the fix changed
    let run: TrailPoint[] = [pts[0]];
    const flush = () => {
      if (run.length > 1) features.push({ type: 'Feature', properties: { colour: css(FIX_COLOURS[run[0].q] || '--q1') }, geometry: { type: 'LineString', coordinates: run.map((p) => [p.lng, p.lat]) } });
    };
    for (let i = 1; i < pts.length; i++) {
      run.push(pts[i]);
      if (pts[i].q !== pts[i - 1].q) {
        flush();
        run = [pts[i]];
      }
    }
    flush();
    const first = pts[0], last = pts[pts.length - 1];
    features.push({ type: 'Feature', properties: { colour: '#2e7d32' }, geometry: { type: 'Point', coordinates: [first.lng, first.lat] } });
    features.push({ type: 'Feature', properties: { colour: '#c62828' }, geometry: { type: 'Point', coordinates: [last.lng, last.lat] } });
  }
  (map.getSource('history-trails') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  const banner = $('#trailBanner');
  banner.classList.toggle('hidden', !historyTrail);
  if (historyTrail) {
    const h = historyTrail;
    banner.innerHTML = `<div><b>${esc(h.who)}</b> · ${h.sessions} session${h.sessions === 1 ? '' : 's'}<div class="sub">${esc(when(h.from))} – ${esc(sameDay(h.from, h.to) ? clock(h.to) : when(h.to))} · <span class="dot-start"></span>start <span class="dot-end"></span>end · hover the trail for times</div></div>
      <button class="link-btn" id="trailBack">Back to history</button><button class="link-btn" id="trailClear">Clear</button>`;
  }
}

function clearHistoryTrail() {
  historyTrail = null;
  drawHistoryTrail([]);
  trailTip.remove();
}

$('#trailBanner').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).id;
  if (id === 'trailClear') clearHistoryTrail();
  else if (id === 'trailBack' && historyTrail) openHistory(historyTrail.serial);
});

$('#historyTable').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-trail-start]');
  if (b) void showTrails([Number(b.dataset.trailStart)]);
});
$('#historyTrailsAll').addEventListener('click', () => {
  const data = historyData;
  if (!data) return;
  const starts = [
    ...data.live.filter((r) => r.gga).map((r) => r.connectedAt),
    ...data.records.filter((r): r is SessionRecord => r.type === 'session' && !!r.trailPoints).map((r) => r.start),
  ].slice(0, 100);
  if (!starts.length) {
    alert('None of the sessions listed have a trail. Trails are kept from now on for machines that send their position.');
    return;
  }
  void showTrails(starts);
});

// Hovering a trail (history or live) shows when the machine was there
const trailTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'trail-tip', offset: 10, maxWidth: '260px' });
let hoverFrame = 0;
map.on('mousemove', (e) => {
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const candidates: TrailPoint[] = historyTrail ? [...historyTrail.points] : [];
    if ($<HTMLInputElement>('#trailsToggle').checked) {
      for (const r of app.rovers.values()) for (const p of r.track || []) candidates.push({ lat: p[0], lng: p[1], t: p[2], q: p[3], who: roverName(r) });
    }
    let best: TrailPoint | null = null;
    let bestD = 12 * 12; // within 12 pixels
    const b = map.getBounds();
    for (const p of candidates) {
      if (p.lng < b.getWest() || p.lng > b.getEast() || p.lat < b.getSouth() || p.lat > b.getNorth()) continue;
      const s = map.project([p.lng, p.lat]);
      const d = (s.x - e.point.x) ** 2 + (s.y - e.point.y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) {
      trailTip.remove();
      map.getCanvas().style.cursor = '';
      return;
    }
    map.getCanvas().style.cursor = 'crosshair';
    const t = new Date(best.t);
    trailTip
      .setLngLat([best.lng, best.lat])
      .setHTML(`<b>${esc(t.toLocaleTimeString([], { hour12: false }))}</b> ${esc(t.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }))}<div>${esc(best.who)} · <span style="color:${css(FIX_COLOURS[best.q] || '--q1')}">●</span> ${esc(FIX_NAMES[best.q] || `Fix ${best.q}`)}</div>`)
      .addTo(map);
  });
});
map.getCanvas().addEventListener('mouseleave', () => trailTip.remove());
historyDlg.addEventListener('click', (e) => {
  if (e.target === historyDlg) historyDlg.close(); // click on the backdrop
});
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-history]');
  if (t?.dataset.history) {
    e.stopPropagation();
    openHistory(t.dataset.history);
  }
});

// settings
const dlg = $<HTMLDialogElement>('#settingsDlg');
const settingsForm = $<HTMLFormElement>('#settingsForm');
const sfield = (name: string) => settingsForm.elements.namedItem(name) as HTMLInputElement;
function openSettings() {
  if (viewOnly()) return;
  // A project with no caster yet is offered the one last used in this browser
  sfield('casterUrl').value = settings.casterUrl || store('casterUrl') || '';
  $('#settingsProjectNote').classList.toggle('hidden', !inConnectProject);
  $('#settingsDevToken').classList.toggle('hidden', !!inConnectProject);
  sfield('devToken').value = settings.devToken;
  if (!dlg.open) dlg.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const url = sfield('casterUrl').value.trim().replace(/\/+$/, '');
  store('casterUrl', url); // last used in this browser
  if (inConnectProject) {
    store(`casterUrl.${inConnectProject}`, url);
    if (projectFiles) {
      void saveProjectSettings(projectFiles, { version: 1, casterUrl: url, savedAt: Date.now() })
        .catch((err) => alert(`Connected, but the caster address could not be saved to the project (${(err as Error).message}). Others on the project will need to enter it too.`));
    }
  } else {
    store('devToken', sfield('devToken').value.trim());
  }
  app.fitted = false;
  app.framedCount = 0;
  app.retry = 0;
  connect();
});

// keep durations ticking between server updates
setInterval(() => {
  if (app.ws) {
    renderRovers();
    renderBases();
  }
}, 5000);

// ------------------------------------------------------------------ start
renderAll();
connectToHost()
  .then((host) => {
    if (!host) {
      basemap.setProject(null);
      connect();
      return;
    }
    app.host = host;
    inConnectProject = host.projectId;
    basemap.setProject(host.projectId);
    projectFiles = new ProjectFiles(host.projectId, host.token, host.location);
    currentProjectId = host.projectId;
    basemap.refreshSharing();
    // GeoTIFFs in a projected CRS are placed using the EPSG registry; the project's CRS fills in when the file has none.
    void initGeoreference(host.crs);
    let first = true;
    host.onToken(() => {
      if (first) {
        // Base maps shared with the project are read once there is a token to read project files with.
        const project = projectFiles!;
        void loadShared(project)
          .then((shared) => shared && restoreSharedGeoTiffs(project, host.projectId, shared))
          .catch((err) => console.warn('[ntrip] could not read the base maps shared with the project', err));
      }
      if (first) {
        first = false;
        // Use the caster saved with the project (it may have changed since this browser last opened it)
        setPill('wait', 'Loading project settings…');
        void loadProjectSettings(projectFiles!)
          .then((saved) => {
            if (saved && saved.casterUrl !== settings.casterUrl) store(`casterUrl.${host.projectId}`, saved.casterUrl);
          })
          .catch((err) => console.warn('[ntrip] could not read the caster settings saved with the project', err))
          .finally(connect);
        return;
      }
      if (!app.ws) connect();
    });
  })
  .catch((err) => {
    console.error('Could not connect to Trimble Connect', err);
    basemap.setProject(null);
    connect();
  });
