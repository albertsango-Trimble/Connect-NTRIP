/**
 * Base maps for the caster map, the same set as the 360 Imagery Viewer's map pane:
 * Street (OpenStreetMap), Satellite (Esri World Imagery), WMTS (capabilities URL or {z}/{x}/{y} tile URL),
 * and GeoTIFF (several at once, from this computer or read in place from the Connect project,
 * reprojected from their own CRS, remembered per project in this browser).
 *
 * Adapted from Connect-360 src/panes/mapPane.ts; the GeoTIFF/WMTS modules in ../core are shared copies.
 */
import maplibregl from 'maplibre-gl';
import { readGeoTiff } from '../core/geotiff';
import { registerTiles, tileUrl, TiffTiles, unregisterTiles, type RangeClient, type TilesInfo } from '../core/geotiffTiles';
import type { ProjectItem } from '../connect/projectFiles';
import { deleteGeoTiff, listGeoTiffs, putGeoTiff } from '../state/geotiffStore';
import type { SharedGeoTiff } from '../connect/sharedSession';
import { buildTileUrl, isTileTemplate, normalizeTemplate, parseCapabilities, type WmtsCapabilities } from '../core/wmts';

type BaseMode = 'street' | 'satellite' | 'wmts' | 'geotiff';

interface WmtsSetting {
  tiles: string;
  attribution: string;
  title: string;
}

interface SavedBase {
  mode: BaseMode;
  wmts?: WmtsSetting;
}

const STORAGE_KEY = 'connect-ntrip.basemap';
const HIDDEN_KEY = 'connect-ntrip.geotiffs-hidden';

const ESRI_ATTRIBUTION = 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** The style the map starts with: the two built-in base maps, street shown. */
export const baseStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    street: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: ESRI_ATTRIBUTION,
    },
  },
  layers: [
    { id: 'blank', type: 'background', paint: { 'background-color': '#eef1f4' } },
    { id: 'street', type: 'raster', source: 'street' },
    { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
  ],
};

function loadSaved(): SavedBase {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SavedBase>;
      if (parsed.mode === 'street' || parsed.mode === 'satellite' || parsed.mode === 'wmts' || parsed.mode === 'geotiff') {
        return { mode: parsed.mode, wmts: parsed.wmts };
      }
    }
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return { mode: 'street' };
}

function save(state: SavedBase): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not critical.
  }
}

/** A GeoTIFF chosen to add: a file from this computer, or one in the project (read in place, never downloaded whole) */
export type GeoTiffChoice = { file: File } | { item: ProjectItem };

export interface BasemapOptions {
  /** Asks the person for a GeoTIFF (from this computer or the project), one or several; empty when they cancel */
  chooseGeoTiff?: () => Promise<GeoTiffChoice[]>;
  /** Reads a project file a piece at a time; null when no project is open */
  projectTiffClient?: (item: ProjectItem) => RangeClient | null;
  /** The lowest layer drawn over the base maps, so base maps are inserted beneath it */
  beforeId: () => string | undefined;
  /** Whether there is anything on the map yet (bases or machines); if not, a new base map's extent is framed */
  hasContent: () => boolean;
  /** Called after a GeoTIFF is added or removed by the person, so the project's shared base maps can be updated */
  geoTiffsChanged?: () => void;
  /** Sharing the GeoTIFF base maps with everyone on the project; undefined hides the option */
  sharing?: {
    /** Whether this project's base maps are being shared */
    isOn(): boolean;
    /** False when not inside a Connect project, so the option is greyed out */
    available(): boolean;
    /** Turns sharing on or off; resolves with an error message, or null when it worked */
    set(on: boolean): Promise<string | null>;
  };
}

export interface Basemap {
  /** Says which project is open (null when not inside Connect), so its saved GeoTIFF base maps can be brought back */
  setProject(projectId: string | null): void;
  /** Call from the map's load event, after the overlay layers have been added */
  onLoad(): void;
  /** The GeoTIFF base maps now added, with their pictures */
  geoTiffs(): { info: SharedGeoTiff; picture?: Blob }[];
  /** Resolves once the saved GeoTIFFs have been brought back */
  loaded(): Promise<void>;
  /** Adds one that came from the project's shared base maps (kept here too); does nothing if it is already added */
  addSharedGeoTiff(info: SharedGeoTiff, picture: Blob | null): Promise<void>;
  /** Takes one away because it was removed from the shared base maps */
  removeSharedGeoTiff(id: string): void;
  /** Redraws the share option, e.g. once the project is known */
  refreshSharing(): void;
}

export function createBasemap(map: maplibregl.Map, container: HTMLElement, options: BasemapOptions): Basemap {
  const saved = loadSaved();
  let mode: BaseMode = saved.mode === 'wmts' && !saved.wmts ? 'street' : saved.mode;
  let wmts: WmtsSetting | undefined = saved.wmts;
  // GeoTIFF is the default base map whenever the project has one: it is kept if it was the last base map used (or none was ever
  // chosen), even though the GeoTIFFs only arrive a moment after the map opens.
  let hadChoice = true;
  try {
    hadChoice = localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // storage unavailable
  }
  let wantTiff = saved.mode === 'geotiff' || !hadChoice;
  let ready = false;

  // ---- North arrow: turns with the map, and a click turns the map back to north ----
  const north = document.createElement('button');
  north.type = 'button';
  north.className = 'north-arrow';
  north.title = 'North. Click to turn the map back to north (right-drag or two fingers turn the map)';
  north.setAttribute('aria-label', 'North arrow: click to face north');
  north.innerHTML = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
    <circle cx="20" cy="20" r="18" fill="rgba(255,255,255,0.92)" stroke="#8a96a1" />
    <g class="north-needle"><path d="M20 5 L26 20 L14 20 Z" fill="#c62828" /><path d="M20 35 L26 20 L14 20 Z" fill="#8a96a1" /></g>
  </svg>`;
  container.appendChild(north);
  const needle = north.querySelector('.north-needle') as SVGGElement;
  map.on('rotate', () => needle.setAttribute('transform', `rotate(${-map.getBearing()} 20 20)`));
  north.addEventListener('click', () => map.easeTo({ bearing: 0, duration: 400 }));

  // ---- Base map control ----
  const control = document.createElement('div');
  control.className = 'basemap-ctl';
  control.innerHTML = `
    <div class="basemap-buttons" role="group" aria-label="Base map">
      <button type="button" data-mode="street">Street</button>
      <button type="button" data-mode="satellite">Satellite</button>
      <button type="button" data-mode="wmts">WMTS</button>
      <button type="button" data-mode="geotiff" title="Use a georeferenced TIFF as the base map">GeoTIFF</button>
    </div>
    <div class="wmts-panel geotiff-panel" hidden>
      <div class="geotiff-empty">No GeoTIFFs added yet.</div>
      <div class="geotiff-list"></div>
      <div class="geotiff-progress" hidden>
        <div class="geotiff-progress-label"></div>
        <div class="geotiff-bar"><i></i></div>
      </div>
      <div class="wmts-actions">
        <button type="button" class="geotiff-choose">Add GeoTIFF…</button>
      </div>
      <label class="geotiff-share" hidden><input type="checkbox" class="geotiff-share-box" /><span class="geotiff-share-note"></span></label>
      <div class="wmts-status geotiff-status" role="status"></div>
    </div>
    <div class="wmts-panel" hidden>
      <label>WMTS capabilities URL, or a tile URL with {z}/{x}/{y}
        <input type="text" class="wmts-url" spellcheck="false" placeholder="https://…/WMTSCapabilities.xml  or  https://…/{z}/{x}/{y}.png" />
      </label>
      <label class="wmts-layer-row" hidden>Layer <select class="wmts-layer"></select></label>
      <label>Attribution (optional)
        <input type="text" class="wmts-attribution" placeholder="© Provider" />
      </label>
      <div class="wmts-actions">
        <button type="button" class="wmts-load">Load</button>
        <button type="button" class="wmts-apply" hidden>Use this layer</button>
        <button type="button" class="wmts-clear">Clear</button>
      </div>
      <div class="wmts-status" role="status"></div>
    </div>`;
  container.appendChild(control);

  const q = <T extends HTMLElement>(selector: string) => control.querySelector(selector) as T;
  const panel = q<HTMLDivElement>('.wmts-panel:not(.geotiff-panel)');
  const tiffPanel = q<HTMLDivElement>('.geotiff-panel');
  const tiffEmpty = q<HTMLDivElement>('.geotiff-empty');
  const tiffList = q<HTMLDivElement>('.geotiff-list');
  const tiffChoose = q<HTMLButtonElement>('.geotiff-choose');
  const tiffProgress = q<HTMLDivElement>('.geotiff-progress');
  const tiffProgressLabel = q<HTMLDivElement>('.geotiff-progress-label');
  const tiffBar = q<HTMLDivElement>('.geotiff-bar');
  const tiffStatus = q<HTMLDivElement>('.geotiff-status');
  const shareRow = q<HTMLLabelElement>('.geotiff-share');
  const shareBox = q<HTMLInputElement>('.geotiff-share-box');
  const shareNote = q<HTMLSpanElement>('.geotiff-share-note');
  const SHARE_TEXT = ' Share these GeoTIFFs with everyone on the project (kept on the caster; project admins only)';
  const refreshSharing = () => {
    const sharing = options.sharing;
    shareRow.hidden = !sharing;
    if (!sharing) return;
    shareBox.checked = sharing.isOn();
    shareBox.disabled = !sharing.available();
    shareNote.textContent = sharing.available() ? SHARE_TEXT : ' Sharing with the project is available when the extension is opened inside a Trimble Connect project';
  };
  shareBox.addEventListener('change', () => {
    const sharing = options.sharing;
    if (!sharing) return;
    const on = shareBox.checked;
    shareBox.disabled = true;
    void sharing.set(on).then((error) => {
      shareBox.disabled = false;
      if (error) {
        shareBox.checked = !on;
        shareNote.textContent = ` Couldn't save to the project: ${error}`;
      } else {
        shareNote.textContent = SHARE_TEXT;
      }
    });
  });
  refreshSharing();
  const urlInput = q<HTMLInputElement>('.wmts-url');
  const layerRow = q<HTMLLabelElement>('.wmts-layer-row');
  const layerSelect = q<HTMLSelectElement>('.wmts-layer');
  const attributionInput = q<HTMLInputElement>('.wmts-attribution');
  const loadBtn = q<HTMLButtonElement>('.wmts-load');
  const applyBtn = q<HTMLButtonElement>('.wmts-apply');
  const clearBtn = q<HTMLButtonElement>('.wmts-clear');
  const statusEl = q<HTMLDivElement>('.wmts-status');

  let capabilities: WmtsCapabilities | null = null;

  const setStatus = (kind: 'ok' | 'warn' | 'err' | '', message: string) => {
    statusEl.className = `wmts-status ${kind}`;
    statusEl.textContent = message;
  };

  const updateButtons = () => {
    control.querySelectorAll<HTMLButtonElement>('.basemap-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  };

  const showBase = () => {
    if (!ready) return;
    // GeoTIFFs are drawn over the street map so that their see-through edges show it.
    (['street', 'satellite', 'wmts'] as const).forEach((id) => {
      const on = id === mode || (id === 'street' && mode === 'geotiff');
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
    tiffs.forEach((t) => {
      if (map.getLayer(tiffLayer(t.id))) map.setLayoutProperty(tiffLayer(t.id), 'visibility', mode === 'geotiff' && t.visible ? 'visible' : 'none');
    });
    updateButtons();
  };

  const persist = () => save({ mode: wantTiff && mode !== 'geotiff' && tiffs.length === 0 ? 'geotiff' : mode, wmts });
  /** Switches to the GeoTIFF base map once there are GeoTIFFs, when that is the person's usual choice. */
  const preferTiff = () => {
    if (!wantTiff || tiffs.length === 0 || mode === 'geotiff') return;
    mode = 'geotiff';
    showBase();
    updateButtons();
  };

  // ---- GeoTIFF base maps: several can be added, and they are remembered for the project ----
  interface TiffEntry {
    id: string;
    name: string;
    crs: string;
    coordinates: [[number, number], [number, number], [number, number], [number, number]];
    width: number;
    height: number;
    addedAt: number;
    visible: boolean;
    /** Reduced picture (a file that can't be reopened), shown as an image */
    png?: Blob;
    url?: string;
    /** Set when shown as tiles drawn from the original file, at its own resolution */
    tiles?: TilesInfo;
    /** The project file, so it can be read again */
    item?: ProjectItem;
    /** The file from this computer, for this visit */
    local?: File;
    overview?: Blob;
    opening?: Promise<TiffTiles>;
  }
  const tiffs: TiffEntry[] = [];
  const tiffLayer = (id: string) => `geotiff-${id}`;
  let projectKey: string | null = null;
  let projectKnown = false;
  let loadingTiff = false;
  const hiddenIds = (): string[] => {
    try {
      const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, string[]>;
      return all[projectKey ?? 'local'] ?? [];
    } catch {
      return [];
    }
  };
  const saveHidden = () => {
    try {
      const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, string[]>;
      all[projectKey ?? 'local'] = tiffs.filter((t) => !t.visible).map((t) => t.id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(all));
    } catch {
      // Not critical.
    }
  };
  const boundsOf = (t: TiffEntry): [[number, number], [number, number]] => {
    const lons = t.coordinates.map((c) => c[0]);
    const lats = t.coordinates.map((c) => c[1]);
    return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  };
  const tiffMessage = (kind: 'ok' | 'warn' | 'err' | '', text: string) => {
    tiffStatus.className = `wmts-status geotiff-status ${kind}`;
    tiffStatus.textContent = text;
  };
  const showProgress = (fraction: number, label: string, indeterminate = false) => {
    tiffProgress.hidden = false;
    tiffBar.classList.toggle('busy', indeterminate);
    tiffBar.style.setProperty('--progress', `${Math.round(fraction * 100)}%`);
    tiffProgressLabel.textContent = indeterminate ? label : `${label} ${Math.round(fraction * 100)}%`;
  };
  const toRecord = (t: TiffEntry) => ({
    id: t.id,
    name: t.name,
    crs: t.crs,
    coordinates: t.coordinates,
    width: t.width,
    height: t.height,
    addedAt: t.addedAt,
    png: t.png,
    item: t.item,
    tiles: t.item ? t.tiles : undefined,
    overview: t.overview,
  });
  /** Keeps (or updates) what is remembered about a GeoTIFF: project files and files with a reduced picture can be brought back. */
  const keepTiff = async (t: TiffEntry) => {
    if (!t.item && !t.png) return;
    await putGeoTiff(projectKey ?? 'local', toRecord(t));
  };
  /** Opens the original file the first time a tile of it is wanted. */
  const openTiles = (t: TiffEntry): Promise<TiffTiles> =>
    (t.opening ??= (async () => {
      const source = t.local ?? (t.item ? options.projectTiffClient?.(t.item) : null);
      if (!source) throw new Error("it can't be read here; open the extension in its project");
      const tiles = await TiffTiles.open(source);
      tiles.onProblem = (message) => tiffMessage('err', `${t.name}: ${message}`);
      if (tiles.info.needsOverview) {
        if (t.overview) {
          await tiles.loadOverview(t.overview);
        } else {
          // A file without overviews needs a coarse one for zooming out; built once and kept.
          tiffPanel.hidden = false;
          await tiles.buildOverview((fraction) => showProgress(fraction, `Preparing ${t.name} for zooming out…`));
          tiffProgress.hidden = true;
          t.overview = tiles.overviewPicture ?? undefined;
          await keepTiff(t).catch(() => undefined);
        }
      }
      return tiles;
    })().catch((err: unknown) => {
      t.opening = undefined;
      tiffProgress.hidden = true;
      tiffMessage('err', `${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }));
  const addTiffLayer = (t: TiffEntry) => {
    if (t.tiles) {
      const [[west, south], [east, north]] = boundsOf(t);
      registerTiles(t.id, () => openTiles(t));
      map.addSource(tiffLayer(t.id), { type: 'raster', tiles: [tileUrl(t.id)], tileSize: 256, maxzoom: t.tiles.maxZoom, bounds: [west, south, east, north] });
    } else {
      map.addSource(tiffLayer(t.id), { type: 'image', url: t.url as string, coordinates: t.coordinates });
    }
    // under the trails, bases and machines
    map.addLayer({ id: tiffLayer(t.id), type: 'raster', source: tiffLayer(t.id), layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } }, options.beforeId());
  };
  const dropTiff = (t: TiffEntry) => {
    if (map.getLayer(tiffLayer(t.id))) map.removeLayer(tiffLayer(t.id));
    if (map.getSource(tiffLayer(t.id))) map.removeSource(tiffLayer(t.id));
    unregisterTiles(t.id);
    if (t.url) URL.revokeObjectURL(t.url);
    tiffs.splice(tiffs.indexOf(t), 1);
  };
  const renderTiffList = () => {
    tiffEmpty.hidden = tiffs.length > 0;
    tiffList.replaceChildren(
      ...tiffs.map((t) => {
        const row = document.createElement('div');
        row.className = 'geotiff-row';
        const label = document.createElement('label');
        label.title = `${t.name} (${t.crs}, ${t.width} × ${t.height} px)`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = t.visible;
        box.addEventListener('change', () => {
          t.visible = box.checked;
          saveHidden();
          showBase();
        });
        const text = document.createElement('span');
        text.textContent = t.name + (!t.tiles ? ' (reduced)' : !t.item && !t.png ? ' (this visit only)' : '');
        label.append(box, text);
        const zoom = document.createElement('button');
        zoom.type = 'button';
        zoom.textContent = 'Zoom';
        zoom.addEventListener('click', () => {
          if (!t.visible) {
            t.visible = true;
            saveHidden();
            showBase();
            renderTiffList();
          }
          map.fitBounds(boundsOf(t), { padding: 20, duration: 400 });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          const id = t.id;
          dropTiff(t);
          saveHidden();
          if (tiffs.length === 0 && mode === 'geotiff') mode = 'street';
          showBase();
          persist();
          renderTiffList();
          tiffMessage('', '');
          deleteGeoTiff(projectKey ?? 'local', id).catch((err) => console.warn('[ntrip] could not forget a GeoTIFF', err));
          options.geoTiffsChanged?.();
        });
        row.append(label, zoom, remove);
        return row;
      }),
    );
  };
  /** Brings back the GeoTIFFs saved for this project. */
  const restoreTiffs = async () => {
    if (!ready || !projectKnown) return;
    const key = projectKey ?? 'local';
    [...tiffs].forEach(dropTiff);
    try {
      const savedTiffs = await listGeoTiffs(key);
      if ((projectKey ?? 'local') !== key) return;
      const hidden = hiddenIds();
      for (const rec of savedTiffs) {
        const projectTiles = !!(rec.item && rec.tiles);
        if (!projectTiles && !rec.png) continue;
        const entry: TiffEntry = { ...rec, url: projectTiles ? undefined : URL.createObjectURL(rec.png as Blob), tiles: projectTiles ? rec.tiles : undefined, visible: !hidden.includes(rec.id) };
        tiffs.push(entry);
        addTiffLayer(entry);
      }
    } catch (err) {
      console.warn('[ntrip] could not load the saved GeoTIFFs', err);
    }
    if (tiffs.length === 0 && mode === 'geotiff') mode = 'street';
    preferTiff();
    showBase();
    renderTiffList();
    // With nothing else to frame, show where the GeoTIFFs are.
    const shown = tiffs.filter((t) => t.visible).map(boundsOf);
    if (mode === 'geotiff' && shown.length > 0 && !options.hasContent()) {
      const west = Math.min(...shown.map((b) => b[0][0]));
      const south = Math.min(...shown.map((b) => b[0][1]));
      const east = Math.max(...shown.map((b) => b[1][0]));
      const northB = Math.max(...shown.map((b) => b[1][1]));
      map.fitBounds([[west, south], [east, northB]], { padding: 20, duration: 0 });
    }
  };
  /** Files with no overviews are read through once to build one; beyond this size that is too slow in a browser. */
  const MAX_NO_OVERVIEW = 8e9;
  const chooseTiff = async () => {
    if (loadingTiff) return;
    if (!options.chooseGeoTiff) return tiffMessage('err', 'GeoTIFFs can be chosen once the extension has loaded.');
    const choices = await options.chooseGeoTiff();
    if (choices.length === 0) return;
    tiffPanel.hidden = false;
    loadingTiff = true;
    tiffChoose.disabled = true;
    tiffMessage('', '');
    const added: TiffEntry[] = [];
    const failed: string[] = [];
    const visitOnly: string[] = [];
    let remembered = true;
    try {
      if (!ready) throw new Error('The map is still loading, try again in a moment');
      for (const [n, choice] of choices.entries()) {
        const local = 'file' in choice ? choice.file : undefined;
        const item = 'item' in choice ? choice.item : undefined;
        const name = (local?.name ?? item?.name) as string;
        const size = local?.size ?? item?.size ?? 0;
        const prefix = choices.length > 1 ? `(${n + 1} of ${choices.length}) ` : '';
        showProgress(0, `${prefix}Opening ${name}…`, true);
        try {
          const source = local ?? (item ? options.projectTiffClient?.(item) : null);
          if (!source) throw new Error('open the extension inside the project to use its files');
          const tiles = await TiffTiles.open(source);
          if (tiles.info.needsOverview) {
            if (size > MAX_NO_OVERVIEW) {
              throw new Error(`has no overviews and is too large (${(size / 1e9).toFixed(0)} GB) to prepare in the browser. Convert it to a Cloud Optimized GeoTIFF first, for example: gdal_translate -of COG in.tif out.tif`);
            }
            await tiles.buildOverview((fraction) => showProgress(fraction, `${prefix}Preparing ${name} for zooming out…`));
          }
          // Adding a file with the same name again replaces the earlier copy.
          const old = tiffs.find((t) => t.name === name);
          if (old) {
            const oldId = old.id;
            dropTiff(old);
            deleteGeoTiff(projectKey ?? 'local', oldId).catch(() => undefined);
          }
          const entry: TiffEntry = {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name,
            crs: tiles.info.crs,
            coordinates: tiles.info.coordinates,
            width: tiles.info.width,
            height: tiles.info.height,
            addedAt: Date.now(),
            visible: true,
            tiles: tiles.info,
            item,
            local,
            overview: tiles.overviewPicture ?? undefined,
            opening: Promise.resolve(tiles),
          };
          tiles.onProblem = (message) => tiffMessage('err', `${name}: ${message}`);
          tiffs.push(entry);
          addTiffLayer(entry);
          added.push(entry);
          wantTiff = true;
          mode = 'geotiff';
          showBase();
          persist();
          renderTiffList();
          try {
            await keepTiff(entry);
            options.geoTiffsChanged?.();
          } catch {
            remembered = false;
          }
          if (local) {
            // A file from this computer can't be reopened next time, so keep a reduced picture of it instead (if it is small enough to read whole).
            if (local.size <= 1.5e9) {
              void readGeoTiff(local)
                .then(async (image) => {
                  URL.revokeObjectURL(image.url);
                  entry.png = image.blob;
                  renderTiffList();
                  await keepTiff(entry);
                  options.geoTiffsChanged?.();
                })
                .catch((err) => console.warn('[ntrip] could not keep a reduced picture', err));
            } else {
              visitOnly.push(name);
            }
          }
        } catch (err) {
          failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (added.length > 0) {
        const bounds = added.map(boundsOf);
        map.fitBounds(
          [[Math.min(...bounds.map((b) => b[0][0])), Math.min(...bounds.map((b) => b[0][1]))], [Math.max(...bounds.map((b) => b[1][0])), Math.max(...bounds.map((b) => b[1][1]))]],
          { padding: 20, duration: 0 },
        );
      }
      const summary = added.length === 1 ? `Added ${added[0].name}.` : `Added ${added.length} of ${choices.length} GeoTIFFs.`;
      if (failed.length > 0) tiffMessage('err', `${added.length > 0 ? `${summary} ` : ''}Could not add ${failed.join('; ')}`);
      else if (!remembered) tiffMessage('warn', `${summary} Some could not be remembered for next time.`);
      else if (visitOnly.length > 0) tiffMessage('warn', `${summary} ${visitOnly.join(', ')} is too large to keep from this computer, so it is here for this visit only. Put it in the project and add it from there to keep it.`);
      else tiffMessage('ok', summary);
    } catch (err) {
      tiffMessage('err', err instanceof Error ? err.message : String(err));
    } finally {
      loadingTiff = false;
      tiffChoose.disabled = false;
      tiffProgress.hidden = true;
    }
  };
  tiffChoose.addEventListener('click', () => void chooseTiff());
  renderTiffList();

  /** Replaces the custom tile layer, keeping it under the overlays. */
  const setWmtsLayer = (setting: WmtsSetting) => {
    if (map.getLayer('wmts')) map.removeLayer('wmts');
    if (map.getSource('wmts')) map.removeSource('wmts');
    map.addSource('wmts', { type: 'raster', tiles: [setting.tiles], tileSize: 256, maxzoom: 22, attribution: setting.attribution });
    map.addLayer({ id: 'wmts', type: 'raster', source: 'wmts', layout: { visibility: 'none' } }, options.beforeId());
  };

  const applyWmts = (setting: WmtsSetting, bbox?: { west: number; south: number; east: number; north: number } | null) => {
    wmts = setting;
    mode = 'wmts';
    if (ready) {
      setWmtsLayer(setting);
      showBase();
      // Show the layer's extent if there's nothing else to frame.
      if (bbox && !options.hasContent()) {
        map.fitBounds([[bbox.west, bbox.south], [bbox.east, bbox.north]], { padding: 20, duration: 0 });
      }
    }
    persist();
    updateButtons();
    setStatus('ok', `Using “${setting.title}”.`);
  };

  const clearWmts = () => {
    wmts = undefined;
    capabilities = null;
    layerRow.hidden = true;
    applyBtn.hidden = true;
    layerSelect.replaceChildren();
    urlInput.value = '';
    attributionInput.value = '';
    if (ready && map.getLayer('wmts')) map.removeLayer('wmts');
    if (ready && map.getSource('wmts')) map.removeSource('wmts');
    if (mode === 'wmts') mode = 'street';
    showBase();
    persist();
    setStatus('', '');
  };

  control.querySelectorAll<HTMLButtonElement>('.basemap-buttons button').forEach((button) => {
    button.addEventListener('click', () => {
      const requested = button.dataset.mode as BaseMode;
      wantTiff = requested === 'geotiff';
      if (requested === 'geotiff') {
        panel.hidden = true;
        if (tiffs.length > 0) {
          // Clicking GeoTIFF again while it is the active base map closes its panel.
          tiffPanel.hidden = mode === 'geotiff' ? !tiffPanel.hidden : false;
          mode = 'geotiff';
          showBase();
          persist();
        } else {
          tiffPanel.hidden = false;
          void chooseTiff();
        }
        updateButtons();
        return;
      }
      tiffPanel.hidden = true;
      if (requested === 'wmts') {
        // Clicking WMTS again while it's the active base map closes the settings panel.
        panel.hidden = !panel.hidden && mode === 'wmts';
        if (wmts) {
          mode = 'wmts';
          showBase();
          persist();
        }
        if (!wmts) setStatus('', 'Enter a WMTS capabilities URL or a tile URL to add a layer.');
      } else {
        mode = requested;
        panel.hidden = true;
        showBase();
        persist();
      }
      updateButtons();
    });
  });

  loadBtn.addEventListener('click', async () => {
    const value = urlInput.value.trim();
    if (!value) {
      setStatus('err', 'Paste a URL first.');
      return;
    }
    const attribution = attributionInput.value.trim();

    // A tile template can be used straight away.
    if (isTileTemplate(value)) {
      applyWmts({ tiles: normalizeTemplate(value), attribution, title: 'Custom tiles' });
      return;
    }

    setStatus('warn', 'Fetching capabilities…');
    layerRow.hidden = true;
    applyBtn.hidden = true;
    try {
      const res = await fetch(value);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      capabilities = parseCapabilities(await res.text());
      layerSelect.replaceChildren(
        ...capabilities.layers.map((layer, i) => {
          const option = document.createElement('option');
          option.value = String(i);
          option.textContent = layer.title;
          return option;
        }),
      );
      layerRow.hidden = false;
      applyBtn.hidden = false;
      const n = capabilities.layers.length;
      setStatus('ok', `Found ${n} layer${n === 1 ? '' : 's'}. Pick one and click “Use this layer”.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setStatus('err', `Couldn't read the capabilities (${reason}). If the server blocks browser requests, paste a tile URL with {z}/{x}/{y} instead.`);
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!capabilities) return;
    const layer = capabilities.layers[Number(layerSelect.value)];
    const tiles = layer ? buildTileUrl(layer, capabilities.kvpBase) : null;
    if (!layer || !tiles) {
      setStatus('err', 'This layer has no tile URL I can use (no RESTful template and no GetTile endpoint).');
      return;
    }
    applyWmts({ tiles, attribution: attributionInput.value.trim(), title: layer.title }, layer.bbox);
  });

  clearBtn.addEventListener('click', clearWmts);

  // Restore the saved custom layer's settings into the form.
  if (wmts) {
    urlInput.value = wmts.tiles;
    attributionInput.value = wmts.attribution;
    setStatus('ok', `Using “${wmts.title}”.`);
  }
  updateButtons();

  // Tell the user when custom tiles fail to load, instead of leaving a blank map.
  let tileErrorShown = false;
  map.on('error', (e) => {
    const sourceId = (e as { sourceId?: string }).sourceId;
    if (!sourceId) console.warn('[ntrip] map error', (e as { error?: unknown }).error);
    if (sourceId === 'wmts' && !tileErrorShown) {
      tileErrorShown = true;
      setStatus('warn', 'Some tiles failed to load. Check the URL or token, and that the provider allows this site.');
    }
  });

  let restoring: Promise<void> = Promise.resolve();
  let markReady: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => (markReady = resolve));
  return {
    refreshSharing,
    loaded: async () => {
      await whenReady;
      await restoring;
    },
    geoTiffs: () =>
      tiffs
        .filter((t) => (t.item && t.tiles) || t.png)
        .map((t) => ({
          info: { id: t.id, name: t.name, crs: t.crs, coordinates: t.coordinates, width: t.width, height: t.height, addedAt: t.addedAt, ...(t.item && t.tiles ? { item: t.item, tiles: t.tiles } : {}) },
          picture: t.item && t.tiles ? undefined : t.png,
        })),
    addSharedGeoTiff: async (info, picture) => {
      await whenReady;
      await restoring;
      if (tiffs.some((t) => t.id === info.id)) return;
      const projectTiles = !!(info.item && info.tiles);
      if (!projectTiles && !picture) return;
      const entry: TiffEntry = {
        id: info.id,
        name: info.name,
        crs: info.crs,
        coordinates: info.coordinates,
        width: info.width,
        height: info.height,
        addedAt: info.addedAt,
        visible: true,
        item: projectTiles ? info.item : undefined,
        tiles: projectTiles ? info.tiles : undefined,
        png: projectTiles ? undefined : (picture as Blob),
        url: projectTiles ? undefined : URL.createObjectURL(picture as Blob),
      };
      tiffs.push(entry);
      tiffs.sort((a, b) => a.addedAt - b.addedAt);
      addTiffLayer(entry);
      preferTiff();
      showBase();
      renderTiffList();
      await keepTiff(entry).catch((err) => console.warn('[ntrip] could not keep a shared GeoTIFF', err));
    },
    removeSharedGeoTiff: (id) => {
      const t = tiffs.find((x) => x.id === id);
      if (!t) return;
      dropTiff(t);
      if (tiffs.length === 0 && mode === 'geotiff') mode = 'street';
      showBase();
      renderTiffList();
      deleteGeoTiff(projectKey ?? 'local', id).catch(() => undefined);
    },
    onLoad() {
      ready = true;
      markReady();
      if (wmts) setWmtsLayer(wmts);
      showBase();
      restoring = restoreTiffs();
    },
    setProject(id) {
      projectKey = id;
      projectKnown = true;
      void restoring.then(() => (restoring = restoreTiffs()));
    },
  };
}
