import { fromArrayBuffer, Pool } from 'geotiff';
import proj4 from 'proj4';
import { defineEpsg, getEpsgCode } from './geo';

/** A georeferenced picture ready to lay on the map. */
export interface GeoTiffImage {
  /** Object URL of the rendered picture (PNG) */
  url: string;
  /** The rendered picture itself, so it can be kept and shown again without reading the GeoTIFF */
  blob: Blob;
  /** Top-left, top-right, bottom-right, bottom-left as lon/lat */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /** What the file said its coordinate system was, e.g. "EPSG:28356" */
  crs: string;
  width: number;
  height: number;
}

/** The longest side of the picture drawn on the map; larger files are sampled down to this. */
const MAX_SIDE = 4096;
/** EPSG codes of geographic (degrees) systems seen in practice; their numbers are used as lon/lat directly. */
export const isGeographic = (code: number) => code === 4326 || code === 4283 || code === 7844 || code === 4269 || code === 4258 || (code >= 4000 && code < 5000);

/** Tells the caller how far along reading is: 0..1, what is happening, and whether the length of this step is unknown. */
export type GeoTiffProgress = (fraction: number, label: string, indeterminate?: boolean) => void;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Reads the whole file into memory, reporting progress as it goes. */
async function readBytes(file: File, report: GeoTiffProgress): Promise<ArrayBuffer> {
  if (typeof file.stream !== 'function') return file.arrayBuffer();
  const bytes = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, at);
    at += value.length;
    report(Math.min(1, at / Math.max(1, file.size)) * 0.3, 'Reading the file…');
  }
  return bytes.buffer;
}

/** Makes picture edges that are pure black (no data outside the flight area) see-through, starting from the border only. */
function clearBlackBorder(px: Uint8ClampedArray, width: number, height: number): void {
  const dark = (i: number) => px[i * 4] <= 10 && px[i * 4 + 1] <= 10 && px[i * 4 + 2] <= 10 && px[i * 4 + 3] !== 0;
  const queue: number[] = [];
  const seen = new Uint8Array(width * height);
  const push = (i: number) => {
    if (!seen[i] && dark(i)) {
      seen[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (queue.length) {
    const i = queue.pop() as number;
    px[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < width * (height - 1)) push(i + width);
  }
}

/** Where a GeoTIFF belongs: its coordinate system code, its coordinate system's name for proj4, its bounds in that system and its corners as lon/lat. */
export async function placement(image: { getBoundingBox(): number[]; getGeoKeys(): unknown; fileDirectory: Record<string, unknown> }) {
  if (!image.fileDirectory.ModelPixelScale && !image.fileDirectory.ModelTransformation) throw new Error('This TIFF has no georeferencing (it is not a GeoTIFF)');
  const bbox = image.getBoundingBox() as [number, number, number, number];
  const keys = (image.getGeoKeys() ?? {}) as Record<string, number | undefined>;
  let code = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
  if (!code || code === 32767) {
    // User-defined systems can't be read; fall back to the project's system when it has one.
    const project = Number(getEpsgCode());
    if (!project) throw new Error('This GeoTIFF does not name its coordinate system (EPSG code) and the project has none');
    code = project;
  }
  const [minX, minY, maxX, maxY] = bbox;
  const corners: [number, number][] = [[minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY]];
  const geographic = isGeographic(code);
  const crsName = geographic ? 'EPSG:4326' : code === 3857 ? 'EPSG:3857' : await defineEpsg(String(code));
  const coordinates = (geographic ? corners : corners.map((c) => proj4(crsName, 'EPSG:4326', c))) as GeoTiffImage['coordinates'];
  if (coordinates.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[1]) > 90 || Math.abs(c[0]) > 180)) {
    throw new Error(`The GeoTIFF's coordinates don't make sense for EPSG:${code}`);
  }
  return { code, crsName, bbox, geographic, coordinates };
}

/** Reads a GeoTIFF into a picture and its place on the earth. Throws a readable message when it can't. */
export async function readGeoTiff(file: File, report: GeoTiffProgress = () => {}): Promise<GeoTiffImage> {
  if (file.size > 1.5e9) throw new Error('This file is too large to open in the browser (over 1.5 GB)');
  report(0, 'Reading the file…');
  const tiff = await fromArrayBuffer(await readBytes(file, report)).catch(() => {
    throw new Error('this is not a readable TIFF file');
  });
  const image = await tiff.getImage();
  if (!image.fileDirectory.ModelPixelScale && !image.fileDirectory.ModelTransformation) throw new Error('This TIFF has no georeferencing (it is not a GeoTIFF)');
  const { code, coordinates } = await placement(image);

  // Picture, sampled down when large.
  const w0 = image.getWidth();
  const h0 = image.getHeight();
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  const samples = image.getSamplesPerPixel();
  const photometric = image.fileDirectory.PhotometricInterpretation as number;
  // Photometric 2 is plain red/green/blue and 1 is grey; the rest (YCbCr, which most drone mosaics use, palette, CMYK, white-is-zero) must be converted to RGB.
  const convert = [0, 3, 5, 6, 8].includes(photometric);
  const extra = (image.fileDirectory.ExtraSamples as number[] | undefined)?.[0];
  const hasAlpha = !convert && samples >= 4 && (extra === 1 || extra === 2);
  const bands = convert ? 3 : samples;

  report(0.35, 'Decoding the image…', true);
  await tick();
  const options = { width, height, interleave: true, resampleMethod: 'bilinear' as const };
  const decode = (pool?: Pool) => (convert ? image.readRGB({ ...options, pool }) : image.readRasters({ ...options, pool }));
  let decoded: unknown;
  try {
    // Decoding in background workers keeps the page responsive; fall back to this thread where workers aren't allowed.
    decoded = await decode(new Pool());
  } catch {
    decoded = await decode();
  }
  const raster = decoded as ArrayLike<number>;
  const noData = convert ? null : image.getGDALNoData();

  report(0.7, 'Preparing the picture…');
  await tick();
  const out = new ImageData(width, height);
  const px = out.data;
  // Stretch anything that isn't 8-bit to 0..255 using its own range, ignoring the extreme 0.5% each end.
  let lo = 0;
  let hi = 255;
  const used = bands >= 3 ? 3 : 1;
  const total = width * height;
  let max = -Infinity;
  let min = Infinity;
  const step = Math.max(1, Math.floor(total / 7e5));
  for (let i = 0; i < total; i += step) {
    for (let b = 0; b < used; b++) {
      const v = raster[i * bands + b];
      if (noData !== null && v === noData) continue;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (max > 255 || min < 0 || bands === 1) {
    lo = Number.isFinite(min) ? min : 0;
    hi = Number.isFinite(max) && max > lo ? max : lo + 1;
    if (max > 255 && max - min > 1) {
      const bins = new Uint32Array(1024);
      let counted = 0;
      for (let i = 0; i < total; i += step) {
        for (let b = 0; b < used; b++) {
          const v = raster[i * bands + b];
          if (noData !== null && v === noData) continue;
          bins[Math.min(1023, Math.floor(((v - min) / (max - min)) * 1024))]++;
          counted++;
        }
      }
      let acc = 0;
      let loBin = 0;
      let hiBin = 1023;
      while (loBin < 1023 && acc + bins[loBin] < counted * 0.005) acc += bins[loBin++];
      acc = 0;
      while (hiBin > 0 && acc + bins[hiBin] < counted * 0.005) acc += bins[hiBin--];
      if (hiBin > loBin) {
        hi = min + ((hiBin + 1) / 1024) * (max - min);
        lo = min + (loBin / 1024) * (max - min);
      }
    }
  }
  const norm = (v: number) => Math.max(0, Math.min(255, ((v - lo) / (hi - lo)) * 255));
  const chunk = 600000;
  for (let from = 0; from < total; from += chunk) {
    const to = Math.min(total, from + chunk);
    for (let i = from; i < to; i++) {
      const o = i * bands;
      const p = i * 4;
      if (bands >= 3) {
        px[p] = norm(raster[o]);
        px[p + 1] = norm(raster[o + 1]);
        px[p + 2] = norm(raster[o + 2]);
        px[p + 3] = hasAlpha ? Math.max(0, Math.min(255, raster[o + 3])) : 255;
        if (noData !== null && raster[o] === noData && raster[o + 1] === noData && raster[o + 2] === noData) px[p + 3] = 0;
      } else {
        const g = norm(raster[o]);
        px[p] = px[p + 1] = px[p + 2] = g;
        px[p + 3] = noData !== null && raster[o] === noData ? 0 : 255;
      }
    }
    report(0.7 + (to / total) * 0.2, 'Preparing the picture…');
    await tick();
  }
  if (!hasAlpha && noData === null) clearBlackBorder(px, width, height);

  report(0.92, 'Saving the picture…', true);
  await tick();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(out, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not draw the GeoTIFF');
  report(1, 'Done');
  return { url: URL.createObjectURL(blob), blob, coordinates, crs: `EPSG:${code}`, width: w0, height: h0 };
}
