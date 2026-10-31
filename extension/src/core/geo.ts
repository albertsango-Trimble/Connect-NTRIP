import proj4 from 'proj4';
import { epsgByCode, epsgByName } from './epsgLookup';


let projectCrs: string | null = null;
let epsgCode: string | null = null;

/**
 * Project coordinates (metres) of the 3D viewer's origin. Model coordinates plus this offset
 * give project easting/northing. Leave at 0 when the model is already in project coordinates.
 */
export const modelOrigin = { x: 0, y: 0, z: 0 };

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Called whenever the coordinate system or the model origin changes. */
export function onGeoChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Registers the project coordinate system, e.g.
 * defineProjectCrs('EPSG:28356', '+proj=utm +zone=56 +south +ellps=GRS80 +units=m +no_defs').
 */
export function defineProjectCrs(code: string, proj4Definition: string): void {
  proj4.defs(code, proj4Definition);
  projectCrs = code;
  notify();
}

/** WGS84 lon/lat to project easting/northing, or null if no project CRS is defined. */
export function toProject(lon: number, lat: number): [number, number] | null {
  if (!projectCrs) return null;
  return proj4('EPSG:4326', projectCrs, [lon, lat]) as [number, number];
}

/** Project easting/northing to WGS84 lon/lat, or null if no project CRS is defined. */
export function fromProject(easting: number, northing: number): [number, number] | null {
  if (!projectCrs) return null;
  return proj4(projectCrs, 'EPSG:4326', [easting, northing]) as [number, number];
}

/** 3D viewer model coordinates (metres) to WGS84 lon/lat, or null if it can't be placed. */
export function modelToLonLat(x: number, y: number): [number, number] | null {
  try {
    const result = fromProject(x + modelOrigin.x, y + modelOrigin.y);
    if (!result) return null;
    const [lon, lat] = result;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return [lon, lat];
  } catch {
    return null;
  }
}

export function getEpsgCode(): string | null {
  return epsgCode;
}

/**
 * Works out an EPSG code from a project coordinate system name. Understands explicit codes
 * ("GDA2020 / MGA zone 56 (EPSG:7856)") and common names without one: Australian MGA zones
 * ("MGA2020 Zone 56", "GDA94 / MGA zone 55") and WGS84 UTM zones ("WGS 84 / UTM zone 56S").
 * Returns null for anything else. "MGA zone N" with no datum is taken as GDA2020.
 */
export function parseEpsgCode(name: string | undefined): string | null {
  if (!name) return null;

  const explicit = name.match(/EPSG[:\s]*(\d{4,6})/i);
  if (explicit) return explicit[1];

  if (/MGA|GDA/i.test(name)) {
    const zone = name.match(/zone\s*(\d{2})/i) ?? name.match(/(?:MGA|GDA)[\s\S]*?\b(4[6-9]|5[0-9])\b/i);
    const z = zone ? Number(zone[1]) : 0;
    if (z >= 46 && z <= 59) {
      if (/2020/.test(name)) return String(7800 + z);
      if (/94|1994/.test(name)) return z >= 48 && z <= 58 ? String(28300 + z) : null;
      return String(7800 + z);
    }
  }

  // German Gauss-Krüger (DHDN, 3-degree zones 2 to 5, EPSG:31466 to 31469), e.g. "Germany/GK (NTV2) - Germany DHDN 12 (Zone 4)".
  if (/DHDN/i.test(name)) {
    const zone = name.match(/zone\s*([2-5])\b/i);
    const meridian = name.match(/DHDN\s*(6|9|12|15)\b/i);
    const z = zone ? Number(zone[1]) : meridian ? Number(meridian[1]) / 3 : 0;
    if (z >= 2 && z <= 5) return String(31464 + z);
  }

  // ETRS89 / UTM, used across Europe (EPSG:25828 to 25838).
  if (/ETRS\s*89/i.test(name) && /UTM/i.test(name)) {
    const m = name.match(/zone\s*(\d{1,2})/i);
    const z = m ? Number(m[1]) : 0;
    if (z >= 28 && z <= 38) return String(25800 + z);
  }

  if (/UTM/i.test(name)) {
    const m = name.match(/(?:zone\s*)?\b(\d{1,2})\s*([NS])\b/i) ?? name.match(/zone\s*(\d{1,2})\b/i);
    if (m) {
      const z = Number(m[1]);
      const south = m[2] ? m[2].toUpperCase() === 'S' : /south/i.test(name);
      const north = m[2] ? m[2].toUpperCase() === 'N' : /north/i.test(name);
      if (z >= 1 && z <= 60 && (south || north)) return String((south ? 32700 : 32600) + z);
    }
  }
  return null;
}

/** Readable text inside a base64-encoded Trimble coordinate system file, for name matching. */
function textFromCsi(csib64: string | undefined): string | undefined {
  if (!csib64) return undefined;
  try {
    const raw = atob(csib64);
    const runs = raw.match(/[ -~]{4,}/g);
    return runs ? runs.join(' ') : undefined;
  } catch {
    return undefined;
  }
}

let projectCrsName: string | null = null;
let epsgDetected = false;

/** The coordinate system name the Connect project reports, if any. */
export function getProjectCrsName(): string | null {
  return projectCrsName;
}

/** True if the current EPSG code was worked out from the project, not typed in. */
export function isEpsgFromProject(): boolean {
  return epsgDetected;
}

/** Definitions that need no network lookup: WGS84 UTM, GDA94 MGA and GDA2020 MGA zones. */
function localDefinition(code: number): string | null {
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (code >= 28348 && code <= 28358) return `+proj=utm +zone=${code - 28300} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  if (code >= 7846 && code <= 7859) return `+proj=utm +zone=${code - 7800} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  // DHDN / 3-degree Gauss-Krüger zones 2 to 5 (central meridian 3 x zone, false easting zone x 1,000,000 + 500,000)
  if (code >= 31466 && code <= 31469) {
    const z = code - 31464;
    return `+proj=tmerc +lat_0=0 +lon_0=${z * 3} +k=1 +x_0=${z * 1000000 + 500000} +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs`;
  }
  return null;
}

/**
 * Makes sure proj4 knows an EPSG code (built-in for common Australian and UTM zones, otherwise looked up on epsg.io)
 * and returns its name, e.g. "EPSG:28356".
 */
export async function defineEpsg(code: string): Promise<string> {
  const clean = code.trim().replace(/^EPSG:/i, '');
  if (!/^\d{4,6}$/.test(clean)) throw new Error('Enter a numeric EPSG code, e.g. 28356');
  const name = `EPSG:${clean}`;
  if (!proj4.defs(name)) {
    const local = localDefinition(Number(clean));
    const registered = local ? null : await epsgByCode(Number(clean)).catch(() => null);
    if (local) {
      proj4.defs(name, local);
    } else if (registered) {
      // Every projected EPSG system proj4 can use is built into the app, so no lookup is needed.
      proj4.defs(name, registered.proj4);
    } else {
      let res: Response;
      try {
        res = await fetch(`https://epsg.io/${clean}.proj4`);
      } catch {
        throw new Error(`could not reach epsg.io to look up EPSG:${clean}`);
      }
      if (!res.ok) throw new Error(`EPSG:${clean} was not found`);
      const definition = (await res.text()).trim();
      if (!definition.startsWith('+proj')) throw new Error(`EPSG:${clean} was not found`);
      proj4.defs(name, definition);
    }
  }
  return name;
}

/** Looks up an EPSG code and makes it the project coordinate system. */
export async function setProjectEpsg(code: string): Promise<void> {
  const name = await defineEpsg(code);
  const clean = name.slice(5);
  epsgCode = clean;
  epsgDetected = false;
  projectCrs = name;
  notify();
}

/**
 * Sets the coordinate system from the Connect project's own coordinate system. Nothing is
 * entered by hand. Resolves quietly if the system can't be recognised or looked up.
 */
export async function initGeoreference(projectCrs?: { name?: string; csib64?: string }): Promise<void> {
  projectCrsName = projectCrs?.name ?? null;

  let fromProject = parseEpsgCode(projectCrs?.name) ?? parseEpsgCode(textFromCsi(projectCrs?.csib64));
  if (!fromProject && projectCrs?.name) {
    // Not a name we know by rule: look it up in the EPSG registry by what the name says.
    const match = await epsgByName(projectCrs.name).catch(() => null);
    if (match) {
      fromProject = String(match.code);
      console.info(`[ntrip] project coordinate system "${projectCrs.name}" matched EPSG:${match.code} ${match.name}${match.approximate ? ' (no datum shift available, so positions may be off by a few metres)' : ''}`);
    }
  }
  epsgDetected = fromProject !== null;
  if (!fromProject || epsgCode === fromProject) {
    notify();
    return;
  }
  try {
    await setProjectEpsg(fromProject);
  } catch {
    // The lookup failed; the map shows a message and models are left off it.
  }
  epsgDetected = epsgCode === fromProject;
  notify();
}

/**
 * False when a model's X coordinate is clearly not a UTM or MGA easting (100 km to 900 km),
 * which means the model is in a local grid and can't be placed with the project's coordinate system.
 */
/** True when an easting could really be in the project's coordinate system (no model origin applied). */
export function plausibleEasting(easting: number): boolean {
  const code = Number(epsgCode);
  const utmLike =
    (code >= 32601 && code <= 32660) || (code >= 32701 && code <= 32760) || (code >= 28348 && code <= 28358) || (code >= 7846 && code <= 7859);
  return !utmLike || (easting >= 100000 && easting <= 900000);
}

export function looksLikeProjectCoordinates(x: number): boolean {
  const code = Number(epsgCode);
  const utmLike =
    (code >= 32601 && code <= 32660) || (code >= 32701 && code <= 32760) || (code >= 28348 && code <= 28358) || (code >= 7846 && code <= 7859);
  if (!utmLike) return true;
  const easting = x + modelOrigin.x;
  return easting >= 100000 && easting <= 900000;
}
