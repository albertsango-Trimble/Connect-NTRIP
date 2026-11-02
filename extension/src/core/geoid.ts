/**
 * Turns the ellipsoidal heights bases report into elevations in the project's vertical datum, using the
 * geoid model named in the Connect project's coordinate system (e.g. AUSGeoid2020 → AHD).
 * The geoid grids are read from the PROJ CDN a small piece at a time (they are Cloud Optimized GeoTIFFs).
 */
import { fromUrl, type GeoTIFF } from 'geotiff';
import { getProjectCrsName, getProjectCrsText, onGeoChange } from './geo';

export interface GeoidModel {
  /** e.g. "AUSGeoid2020" */
  name: string;
  /** Vertical datum of the elevations, e.g. "AHD" */
  datum: string;
  file: string;
}

const MODELS: { match: RegExp; model: GeoidModel }[] = [
  { match: /AUS\s*Geoid\s*2020|AUSGeoid20\b/i, model: { name: 'AUSGeoid2020', datum: 'AHD', file: 'au_ga_AUSGeoid2020_20180201.tif' } },
  { match: /AUS\s*Geoid\s*09|AUSGeoid2009/i, model: { name: 'AUSGeoid09', datum: 'AHD', file: 'au_ga_AUSGeoid09_V1.01.tif' } },
  { match: /NZ\s*Geoid\s*2016/i, model: { name: 'NZGeoid2016', datum: 'NZVD2016', file: 'nz_linz_nzgeoid2016.tif' } },
  { match: /EGM\s*(2008|08)\b/i, model: { name: 'EGM2008', datum: 'EGM2008', file: 'us_nga_egm08_25.tif' } },
  { match: /EGM\s*96\b/i, model: { name: 'EGM96', datum: 'EGM96', file: 'us_nga_egm96_15.tif' } },
];

/** The geoid model the project's coordinate system names, or null if it names none. */
export function projectGeoid(): GeoidModel | null {
  const text = `${getProjectCrsName() ?? ''} ${getProjectCrsText() ?? ''}`;
  return MODELS.find((m) => m.match.test(text))?.model ?? null;
}

let tiff: { file: string; open: Promise<GeoTIFF> } | null = null;
const cache = new Map<string, number | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
onGeoChange(() => {
  cache.clear();
  listeners.forEach((l) => l());
});

/** Called when geoid values arrive, so the page can redraw. */
export function onGeoidValue(listener: () => void): void {
  listeners.add(listener);
}

/**
 * Geoid–ellipsoid separation N (metres) at a point: a number, undefined while it is being fetched,
 * or null when it can't be had (no geoid in the project, outside the grid, or the grid can't be read).
 */
export function geoidSeparation(lat: number, lon: number): number | null | undefined {
  const model = projectGeoid();
  if (!model) return null;
  const key = `${model.file}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  if (!pending.has(key)) {
    pending.add(key);
    void sample(model, lat, lon)
      .catch((err) => {
        console.warn(`[ntrip] could not read the ${model.name} geoid`, err);
        return null;
      })
      .then((n) => {
        cache.set(key, n);
        pending.delete(key);
        listeners.forEach((l) => l());
      });
  }
  return undefined;
}

async function sample(model: GeoidModel, lat: number, lon: number): Promise<number | null> {
  if (tiff?.file !== model.file) tiff = { file: model.file, open: fromUrl(`https://cdn.proj.org/${model.file}`) };
  const img = await (await tiff.open).getImage(0);
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  // Grid values sit on pixel centres when the raster is "pixel is area"
  const area = (img.getGeoKeys() as { GTRasterTypeGeoKey?: number } | null)?.GTRasterTypeGeoKey !== 2;
  let fx = (lon - ox) / rx - (area ? 0.5 : 0);
  const fy = (lat - oy) / ry - (area ? 0.5 : 0);
  const w = img.getWidth();
  if (fx < 0 && ox < -170) fx += 360 / rx; // global grids starting at -180
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= img.getHeight()) return null;
  const [band] = (await img.readRasters({ window: [x0, y0, x0 + 2, y0 + 2], samples: [0], interleave: false })) as unknown as ArrayLike<number>[];
  const v = [band[0], band[1], band[2], band[3]];
  if (v.some((x) => !Number.isFinite(x) || Math.abs(x) > 500)) return null; // no-data
  const tx = fx - x0, ty = fy - y0;
  return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty;
}
