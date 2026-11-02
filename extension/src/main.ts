/* Connect-NTRIP: Trimble Connect extension showing the caster's bases and machines live. */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { baseStyle, createBasemap } from './map/basemap';
import { connectToHost, type HostConnection } from './connect/workspace';
import { ProjectFiles } from './connect/projectFiles';
import { RangeClient } from './core/geotiffTiles';
import { fromProject, getEpsgCode, getProjectCrsName, initGeoreference, onGeoChange, toProject } from './core/geo';
import { geoidSeparation, onGeoidValue, projectGeoid } from './core/geoid';
import { chooseSource } from './ui/sourceDialog';
import { loadShared, loadSharedPicture, saveShared, saveSharedPicture, type SharedMap } from './connect/sharedSession';
import type { CasterMessage, Device, HistoryRecord, HistoryReply, LogEvent, Mountpoint, Profile, Receiver, Rover, SessionRecord } from './types';

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
function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(`connect-ntrip.${key}`);
    if (value === null || value === '') localStorage.removeItem(`connect-ntrip.${key}`);
    else localStorage.setItem(`connect-ntrip.${key}`, value);
  } catch {
    /* storage blocked */
  }
  return null;
}
const settings = {
  get casterUrl() { return store('casterUrl') || ''; },
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
};
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
map.on('load', () => {
  map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'trails-casing', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 3, 'line-opacity': 0.85 } });
  mapReady = true;
  basemap.onLoad();
  renderMap();
});
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

function renderMap() {
  if (!mapReady) return;
  mapEl.parentElement!.classList.toggle('hide-labels', !$<HTMLInputElement>('#labelsToggle').checked);

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

  // Trails
  const showTrails = $<HTMLInputElement>('#trailsToggle').checked;
  const features: GeoJSON.Feature[] = showTrails
    ? [...app.rovers.values()]
        .filter((r) => (r.track?.length ?? 0) > 1)
        .map((r) => ({ type: 'Feature', properties: { colour: roverColour(r) }, geometry: { type: 'LineString', coordinates: r.track!.map((p) => [p[1], p[0]]) } }))
    : [];
  (map.getSource('trails') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });

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
        </div>
        ${profileLines(deviceOf(r.serial)?.profile)}
        ${!g ? '<div class="warn">Receiving corrections, but this rover isn\'t sending its position (GGA). Turn on "send NMEA GGA to caster" on the receiver to see it on the map.</div>' : ''}
        <div class="card-sub" style="margin-top:6px">${esc(r.protocol)} · ${esc(r.addr)}${r.agent ? ` · ${esc(r.agent)}` : ''}
          <span style="float:right"><button class="link-btn" data-history="${esc(r.serial)}">History</button><button class="link-btn danger" data-kick="${esc(r.id)}">Disconnect</button></span></div>
      </div>`;
    })
    .join(''));
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

function renderReceivers() {
  if (!app.receivers.length) return '';
  return `<div class="section-title">Base receivers</div>${app.receivers
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
        <div class="card-sub" style="margin-top:6px">${esc(st.text)}</div>
        ${r.webUi ? `<div class="actions"><button class="primary-btn" data-webui="${esc(r.id)}">Open web UI</button><button class="ghost-btn" data-webui-tab="${esc(r.id)}">New tab</button></div>` : ''}
      </div>`;
    })
    .join('')}<div class="section-title">Mountpoints</div>`;
}

function renderBases() {
  const el = $('#tab-bases');
  if (!app.mountpoints.length) {
    el.innerHTML = '<div class="empty">No mountpoints configured on the caster.</div>';
    return;
  }
  morph(el, renderReceivers() + app.mountpoints
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
      ${!m.position ? '<div class="warn">No position: this base isn\'t on the map. Use <b>Set position</b> to place it.</div>' : ''}
      ${!positionFromData(m) || (m.auto && !m.online) ? `<div class="actions" style="margin-top:6px">
        ${!positionFromData(m) ? `<button class="link-btn" data-place="${esc(m.name)}">${m.manualPosition ? 'Change set position' : 'Set position'}</button>` : ''}
        ${m.auto && !m.online ? `<button class="link-btn danger" data-remove-mount="${esc(m.name)}">Remove mountpoint</button>` : ''}
      </div>` : ''}
    </div>`,
    )
    .join(''));
}

function renderDevices() {
  const checks = $('#mountChecks');
  const ticked = new Set([...checks.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value));
  checks.innerHTML = app.mountpoints
    .map((m) => `<label><input type="checkbox" value="${esc(m.name)}"${ticked.has(m.name) ? ' checked' : ''}> ${esc(m.name)} <span class="hint">${esc(m.format)}</span></label>`)
    .join('');

  const live = new Set([...app.rovers.values()].map((r) => r.serial));
  const el = $('#deviceList');
  if (!app.devices.length) {
    el.innerHTML = '<div class="empty">No rover logins yet. Add one above using the receiver\'s serial number.</div>';
    return;
  }
  el.innerHTML = [...app.devices]
    .sort((a, b) => a.serial.localeCompare(b.serial))
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
    case 'device.added': return `Login ${ev.serial} added by ${ev.by}`;
    case 'device.updated': return `Login ${ev.serial} updated (${((ev.fields as string[]) || []).join(', ')}) by ${ev.by}`;
    case 'device.removed': return `Login ${ev.serial} deleted by ${ev.by}`;
    case 'mountpoint.removed': return `Mountpoint ${ev.mount} removed by ${ev.by}`;
    case 'mountpoint.position_set': return `Position of ${ev.mount} set by ${ev.by}`;
    case 'mountpoint.position_cleared': return `Set position of ${ev.mount} cleared by ${ev.by}`;
    case 'webui.opened': return `${receiverName(String(ev.receiver))} web UI opened by ${ev.by}`;
    case 'receiver.reachable': return `${receiverName(String(ev.receiver))} web UI reachable again`;
    case 'receiver.unreachable': return `${receiverName(String(ev.receiver))} web UI not reachable${ev.reason ? ` (${ev.reason})` : ''}`;
    default: return ev.type;
  }
}
function renderLog() {
  $('#logList').innerHTML =
    app.log
      .slice()
      .reverse()
      .map((ev) => {
        const t = new Date(ev.time);
        const cls = GOOD.has(ev.type) ? 'ev-good' : BAD.has(ev.type) ? 'ev-bad' : '';
        return `<li><time>${t.toLocaleTimeString([], { hour12: false })}</time><span class="${cls}">${esc(describe(ev))}</span></li>`;
      })
      .join('') || '<li class="empty">No events yet.</li>';
}

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
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: token() }));
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data as string) as CasterMessage);
  ws.onclose = (e) => {
    app.ws = null;
    if (e.code === 4001) {
      // The token may have expired: Connect sends a fresh one on extension.accessToken, which reconnects.
      setPill('err', 'Not authorised');
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
    app.mountpoints = s.mountpoints;
    app.rovers = new Map(s.rovers.map((r) => [r.id, r]));
    app.log = s.log;
    app.devices = msg.devices;
    app.receivers = s.receivers ?? [];
    renderAll();
  } else if (msg.type === 'tick') {
    app.serverOffset = msg.serverTime - Date.now();
    app.mountpoints = msg.mountpoints;
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
    if (app.log.length > 300) app.log.shift();
    renderLog();
    if (msg.event.type === 'rover.connected' || msg.event.type === 'rover.disconnected') renderDevices();
  } else if (msg.type === 'mountpoints') {
    app.mountpoints = msg.mountpoints;
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
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
      <td>${r.gga ? esc(r.gga.fix) : '<span class="sub">no position sent</span>'}</td><td class="num">${bytes(r.bytesOut)}</td><td class="hide-sm">${esc(r.addr)}</td><td>Connected</td></tr>`);
  }
  for (const r of data.records as HistoryRecord[]) {
    if (r.type === 'rejected') {
      if (!showRejected) continue;
      rows.push(`<tr class="rejected"><td class="num">${when(r.time)}</td><td></td><td>${esc(r.mount)}</td><td colspan="2">Login refused</td><td class="hide-sm">${esc(r.addr)}</td><td>${esc(r.reason)}</td></tr>`);
    } else {
      rows.push(`<tr><td class="num">${when(r.start)}<div class="sub">to ${sameDay(r.start, r.end) ? clock(r.end) : when(r.end)}</div></td><td class="num">${hms(r.durationSec)}</td>
        <td>${esc(r.mount)}<div class="sub hide-sm">${esc(r.protocol)}</div></td><td>${fixBar(r.fixSec)}</td><td class="num">${bytes(r.bytes)}</td>
        <td class="hide-sm">${esc(r.addr)}${r.agent ? `<div class="sub">${esc(r.agent)}</div>` : ''}</td><td>${esc(r.endReason)}</td></tr>`);
    }
  }
  const range = data.days ? `the last ${data.days === 1 ? '24 hours' : `${data.days} days`}` : 'the history kept';
  $('#historyTable').innerHTML = `<thead><tr><th>Connected</th><th>Duration</th><th>Mountpoint</th><th>Fix</th><th>Data</th><th class="hide-sm">From</th><th>Ended</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="7" class="empty">No connections in ${range}.</td></tr>`}</tbody>`;
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
  sfield('casterUrl').value = settings.casterUrl;
  sfield('devToken').value = settings.devToken;
  if (!dlg.open) dlg.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  store('casterUrl', sfield('casterUrl').value.trim());
  store('devToken', sfield('devToken').value.trim());
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
      if (first || !app.ws) connect();
      first = false;
    });
  })
  .catch((err) => {
    console.error('Could not connect to Trimble Connect', err);
    basemap.setProject(null);
    connect();
  });
