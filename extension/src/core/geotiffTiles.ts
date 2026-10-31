import maplibregl from 'maplibre-gl';
import { BaseClient, BaseResponse, fromBlob, fromCustomClient, Pool } from 'geotiff';
import type { GeoTIFFImage } from 'geotiff';
import proj4 from 'proj4';
import { placement } from './geotiff';

/**
 * Draws a GeoTIFF as map tiles straight from the original file, so zooming in shows the file at its
 * own resolution however large it is. Only the part of the file that is in view is read: from a File on
 * this computer, or by byte ranges from the project. A Cloud Optimized GeoTIFF (tiled, with built-in
 * overviews) is read quickly at every zoom. A plain file without overviews gets one coarse overview built
 * once, which is used when zoomed far out.
 */

type Window = [number, number, number, number];
export type Corners = [[number, number], [number, number], [number, number], [number, number]];

/** What is needed to put the picture on the map and draw it consistently, kept with the project. */
export interface TilesInfo {
  crs: string;
  coordinates: Corners;
  width: number;
  height: number;
  /** Zoom at which one tile pixel is one file pixel; zooming in further enlarges the tiles */
  maxZoom: number;
  /** Range that 16-bit and single-band values are stretched from */
  lo: number;
  hi: number;
  /** True when the file has no overviews, so a coarse one is built for zooming out */
  needsOverview: boolean;
}

const TILE = 256;
const GRID = 8;
const R = 6378137;
/** Most pixels read from the file for one tile; beyond this a coarser overview is used. */
const WINDOW_LIMIT = 6_000_000;
/** The longest side of the overview built for files without one. */
const OVERVIEW_SIDE = 4096;
/** Most source pixels read at once while building the overview. */
const BAND_PIXELS = 12_000_000;

/** An address in the project that can be read a range at a time; refreshes the address when it expires. */
export class RangeClient extends BaseClient {
  constructor(private readonly getUrl: (fresh: boolean) => Promise<string>) {
    super('');
  }

  // geotiff's typings are looser than what it really accepts, hence the ignores below.
  // @ts-ignore
  async request({ headers, signal }: { headers?: HeadersInit; signal?: AbortSignal } = {}) {
    let res = await fetch(await this.getUrl(false), { headers, signal });
    if (res.status === 401 || res.status === 403) res = await fetch(await this.getUrl(true), { headers, signal });
    return new RangeResponse(res);
  }
}

class RangeResponse extends BaseResponse {
  constructor(private readonly res: Response) {
    super();
  }

  // @ts-ignore
  get status() {
    return this.res.status;
  }

  getHeader(name: string) {
    return this.res.headers.get(name) as string;
  }

  // @ts-ignore
  async getData() {
    return this.res.arrayBuffer();
  }
}

let pool: Pool | null | undefined;
/** Decoding in background workers keeps the page responsive; undefined where workers aren't allowed. */
const getPool = () => {
  if (pool === undefined) {
    try {
      pool = new Pool();
    } catch {
      pool = null;
    }
  }
  return pool ?? undefined;
};

interface Level {
  width: number;
  height: number;
  /** The window as RGBA pixels */
  read(win: Window): Promise<Uint8ClampedArray>;
}

const transparentTile = (() => {
  let cached: Promise<ArrayBuffer> | null = null;
  return () => (cached ??= encode(new ImageData(TILE, TILE)));
})();

async function encode(data: ImageData): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(data.width, data.height);
    canvas.getContext('2d')!.putImageData(data, 0, 0);
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not draw a tile');
  return blob.arrayBuffer();
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class TiffTiles {
  info!: TilesInfo;
  /** Called with a message when something stops tiles from drawing (the file can't be read, and so on) */
  onProblem: (message: string) => void = () => {};
  private levels: Level[] = [];
  private projectTile!: (x: number, y: number) => [number, number];
  private cache = new Map<string, Promise<ArrayBuffer>>();
  private busy = 0;
  private waiting: (() => void)[] = [];
  private overview: Level | null = null;
  private overviewPng: Blob | null = null;
  private problem = false;

  private constructor() {}

  /** The overview built for a file that has none, as a picture to keep for next time */
  get overviewPicture(): Blob | null {
    return this.overviewPng;
  }

  /** Opens the file (a File on this computer, or a client that reads byte ranges) and reads how it is laid out. */
  static async open(source: Blob | RangeClient): Promise<TiffTiles> {
    const t = new TiffTiles();
    const tiff = await (source instanceof Blob ? fromBlob(source) : fromCustomClient(source as unknown as BaseClient, { blockSize: 256 * 1024, cacheSize: 200 })).catch((err: unknown) => {
      throw new Error(source instanceof Blob ? 'this is not a readable TIFF file' : `the project file couldn't be read in pieces (${err instanceof Error ? err.message : String(err)})`);
    });
    const count = await tiff.getImageCount();
    const images: GeoTIFFImage[] = [];
    for (let i = 0; i < count; i++) {
      const image = await tiff.getImage(i);
      // Skip transparency masks; keep the picture and its reduced-size copies.
      if ((((image.fileDirectory as { NewSubfileType?: number }).NewSubfileType ?? 0) & 4) === 0) images.push(image);
    }
    images.sort((a, b) => b.getWidth() - a.getWidth());
    const full = images[0];
    const place = await placement(full);
    const [minX, minY, maxX, maxY] = place.bbox;
    const w0 = full.getWidth();
    const h0 = full.getHeight();

    const samples = full.getSamplesPerPixel();
    const photometric = full.fileDirectory.PhotometricInterpretation as number;
    // YCbCr (common for drone mosaics), palette, CMYK and white-is-zero must be converted to RGB.
    const convert = [0, 3, 5, 6, 8].includes(photometric);
    const extra = (full.fileDirectory.ExtraSamples as number[] | undefined)?.[0];
    const hasAlpha = !convert && samples >= 4 && (extra === 1 || extra === 2);
    const bands = convert ? 3 : samples;
    const noData = convert ? null : full.getGDALNoData();
    const bits = (full.fileDirectory.BitsPerSample as number[] | undefined)?.[0] ?? 8;
    const used = bands >= 3 ? 3 : 1;

    const raw = async (image: GeoTIFFImage, win: Window): Promise<ArrayLike<number>> => {
      const read = (p?: Pool) => (convert ? image.readRGB({ window: win, interleave: true, pool: p }) : image.readRasters({ window: win, interleave: true, pool: p }));
      try {
        return (await read(getPool())) as unknown as ArrayLike<number>;
      } catch {
        return (await read()) as unknown as ArrayLike<number>;
      }
    };

    // Values that aren't 8-bit RGB are stretched to 0..255 using the range found in a few spots on the picture.
    let lo = 0;
    let hi = 255;
    if (bits !== 8 || bands < 3) {
      const values: number[] = [];
      const span = Math.min(256, w0, h0);
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          const x0 = Math.floor(((w0 - span) * gx) / 2);
          const y0 = Math.floor(((h0 - span) * gy) / 2);
          const part = await raw(full, [x0, y0, x0 + span, y0 + span]);
          for (let i = 0; i < span * span; i += 3) {
            for (let b = 0; b < used; b++) {
              const v = part[i * bands + b];
              if (noData === null || v !== noData) values.push(v);
            }
          }
        }
      }
      values.sort((a, b) => a - b);
      if (values.length > 0) {
        lo = values[Math.floor(values.length * 0.005)];
        hi = values[Math.min(values.length - 1, Math.floor(values.length * 0.995))];
        if (!(hi > lo)) hi = lo + 1;
      }
    }
    const norm = (v: number) => Math.max(0, Math.min(255, ((v - lo) / (hi - lo)) * 255));

    const rgba = (data: ArrayLike<number>, n: number): Uint8ClampedArray => {
      const out = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        const o = i * bands;
        const p = i * 4;
        if (bands >= 3) {
          out[p] = norm(data[o]);
          out[p + 1] = norm(data[o + 1]);
          out[p + 2] = norm(data[o + 2]);
          out[p + 3] = hasAlpha ? data[o + 3] : 255;
          // Outside the flight area a mosaic is pure black (or its no-data value): make that see-through.
          const blank = noData !== null ? data[o] === noData && data[o + 1] === noData && data[o + 2] === noData : !hasAlpha && out[p] <= 4 && out[p + 1] <= 4 && out[p + 2] <= 4;
          if (blank) out[p + 3] = 0;
        } else {
          const g = norm(data[o]);
          out[p] = out[p + 1] = out[p + 2] = g;
          out[p + 3] = noData !== null && data[o] === noData ? 0 : 255;
        }
      }
      return out;
    };

    t.levels = images.map((image) => ({
      width: image.getWidth(),
      height: image.getHeight(),
      read: async (win: Window) => rgba(await raw(image, win), (win[2] - win[0]) * (win[3] - win[1])),
    }));

    // Where tile coordinates (web mercator) land in the file, in file pixels at full resolution.
    const toFile = proj4('EPSG:3857', place.crsName);
    t.projectTile = (mx, my) => {
      const [X, Y] = toFile.forward([mx, my]);
      return [((X - minX) / (maxX - minX)) * w0, ((maxY - Y) / (maxY - minY)) * h0];
    };

    // Zoom at which a tile pixel is a file pixel.
    const lat = ((place.coordinates[0][1] + place.coordinates[2][1]) / 2) * (Math.PI / 180);
    const metresPerPixel = place.geographic ? (((maxX - minX) / w0) * 111320) : ((maxX - minX) / w0) / Math.cos(lat);
    const maxZoom = Math.max(0, Math.min(24, Math.ceil(Math.log2(156543.034 / metresPerPixel))));

    t.info = {
      crs: `EPSG:${place.code}`,
      coordinates: place.coordinates,
      width: w0,
      height: h0,
      maxZoom,
      lo,
      hi,
      needsOverview: images.length === 1 && w0 * h0 > WINDOW_LIMIT,
    };
    return t;
  }

  /** Builds the coarse overview of a file without one, reading it in bands so memory stays small. */
  async buildOverview(report: (fraction: number) => void): Promise<void> {
    const level0 = this.levels[0];
    const k = Math.max(level0.width, level0.height) / OVERVIEW_SIDE;
    const ow = Math.max(1, Math.round(level0.width / k));
    const oh = Math.max(1, Math.round(level0.height / k));
    const out = new Uint8ClampedArray(ow * oh * 4);
    const rowsPerBand = Math.max(Math.ceil(k) + 1, Math.floor(BAND_PIXELS / level0.width));
    const sums = new Float64Array(ow * 5);
    let jr = 0;
    for (let y0 = 0; y0 < level0.height && jr < oh; ) {
      const y1 = Math.min(level0.height, y0 + rowsPerBand);
      const band = await level0.read([0, y0, level0.width, y1]);
      // Output rows whose source rows all lie inside this band (the last band takes the rest).
      while (jr < oh && (y1 === level0.height || (jr + 1) * k <= y1)) {
        sums.fill(0);
        const ys0 = Math.max(y0, Math.floor(jr * k));
        const ys1 = Math.min(y1, Math.max(ys0 + 1, Math.floor((jr + 1) * k)));
        for (let y = ys0; y < ys1; y++) {
          const row = (y - y0) * level0.width;
          for (let x = 0; x < level0.width; x++) {
            const ox = Math.min(ow - 1, Math.floor(x / k));
            const p = (row + x) * 4;
            const a = band[p + 3];
            if (a === 0) continue;
            const s = ox * 5;
            sums[s] += band[p] * a;
            sums[s + 1] += band[p + 1] * a;
            sums[s + 2] += band[p + 2] * a;
            sums[s + 3] += a;
            sums[s + 4] += 1;
          }
        }
        const total = (ys1 - ys0) * k;
        for (let ox = 0; ox < ow; ox++) {
          const s = ox * 5;
          const p = (jr * ow + ox) * 4;
          if (sums[s + 3] > 0) {
            out[p] = sums[s] / sums[s + 3];
            out[p + 1] = sums[s + 1] / sums[s + 3];
            out[p + 2] = sums[s + 2] / sums[s + 3];
            // Mostly covered cells are opaque; edge cells fade.
            out[p + 3] = Math.min(255, (sums[s + 4] / Math.max(1, total)) * 255 * 1.2);
          }
        }
        jr++;
      }
      y0 = y1;
      report(Math.min(1, y1 / level0.height));
      await tick();
    }
    this.setOverview(out, ow, oh);
    this.overviewPng = await encode(new ImageData(out, ow, oh)).then((b) => new Blob([b], { type: 'image/png' }));
  }

  /** Uses a kept overview picture instead of building it again. */
  async loadOverview(picture: Blob): Promise<void> {
    const bitmap = await createImageBitmap(picture);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, bitmap.width, bitmap.height);
    this.setOverview(data.data, bitmap.width, bitmap.height);
    this.overviewPng = picture;
  }

  private setOverview(data: Uint8ClampedArray, width: number, height: number) {
    this.overview = {
      width,
      height,
      read: async ([x0, y0, x1, y1]) => {
        const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
        for (let y = y0; y < y1; y++) out.set(data.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * (x1 - x0) * 4);
        return out;
      },
    };
    this.levels = [...this.levels.filter((l) => l !== this.overview), this.overview].sort((a, b) => b.width - a.width);
  }

  /** The tile as PNG bytes. Tiles that can't be drawn come out see-through. */
  renderTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
    const key = `${z}/${x}/${y}`;
    let tile = this.cache.get(key);
    if (!tile) {
      tile = this.limited(() => this.draw(z, x, y)).catch((err: unknown) => {
        if (!this.problem) {
          this.problem = true;
          this.onProblem(err instanceof Error ? err.message : String(err));
        }
        this.cache.delete(key);
        return transparentTile();
      });
      this.cache.set(key, tile);
      if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value as string);
    }
    return tile;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.busy >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.busy++;
    try {
      return await work();
    } finally {
      this.busy--;
      this.waiting.shift()?.();
    }
  }

  private async draw(z: number, x: number, y: number): Promise<ArrayBuffer> {
    const size = (2 * Math.PI * R) / 2 ** z;
    const originX = -Math.PI * R + x * size;
    const originY = Math.PI * R - y * size;
    // File pixel positions at a grid of points over the tile; positions in between are interpolated.
    const fx = new Float64Array((GRID + 1) ** 2);
    const fy = new Float64Array((GRID + 1) ** 2);
    let minFx = Infinity;
    let minFy = Infinity;
    let maxFx = -Infinity;
    let maxFy = -Infinity;
    for (let gj = 0; gj <= GRID; gj++) {
      for (let gi = 0; gi <= GRID; gi++) {
        const [px, py] = this.projectTile(originX + (size * gi) / GRID, originY - (size * gj) / GRID);
        fx[gj * (GRID + 1) + gi] = px;
        fy[gj * (GRID + 1) + gi] = py;
        minFx = Math.min(minFx, px);
        maxFx = Math.max(maxFx, px);
        minFy = Math.min(minFy, py);
        maxFy = Math.max(maxFy, py);
      }
    }
    const { width: w0, height: h0 } = this.info;
    if (!(maxFx > 0 && minFx < w0 && maxFy > 0 && minFy < h0)) return transparentTile();

    // File pixels per tile pixel; pick the most detailed level that is no finer than needed, and a coarser one if the area is too big to read.
    const mid = (GRID / 2) * (GRID + 1) + GRID / 2;
    const step = Math.hypot(fx[mid + 1] - fx[mid], fy[mid + 1] - fy[mid]) / (TILE / GRID);
    let start = 0;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (w0 / this.levels[i].width <= step * 1.001) {
        start = i;
        break;
      }
    }
    let chosen = -1;
    let win: Window = [0, 0, 0, 0];
    for (let i = start; i < this.levels.length; i++) {
      const f = w0 / this.levels[i].width;
      const l = this.levels[i];
      win = [Math.max(0, Math.floor(minFx / f) - 1), Math.max(0, Math.floor(minFy / f) - 1), Math.min(l.width, Math.ceil(maxFx / f) + 2), Math.min(l.height, Math.ceil(maxFy / f) + 2)];
      if ((win[2] - win[0]) * (win[3] - win[1]) <= WINDOW_LIMIT || i === this.levels.length - 1) {
        chosen = i;
        break;
      }
    }
    const level = this.levels[chosen];
    const f = w0 / level.width;
    const ww = win[2] - win[0];
    const wh = win[3] - win[1];
    if (ww <= 0 || wh <= 0) return transparentTile();
    if (ww * wh > WINDOW_LIMIT * 3) throw new Error('This file has no overviews, so zoomed out it is too large to draw. Zoom in, or convert it to a Cloud Optimized GeoTIFF (gdal_translate -of COG in.tif out.tif).');
    const src = await level.read(win);

    const out = new ImageData(TILE, TILE);
    const px = out.data;
    for (let j = 0; j < TILE; j++) {
      const v = ((j + 0.5) / TILE) * GRID;
      const cj = Math.min(GRID - 1, Math.floor(v));
      const tv = v - cj;
      for (let i = 0; i < TILE; i++) {
        const u = ((i + 0.5) / TILE) * GRID;
        const ci = Math.min(GRID - 1, Math.floor(u));
        const tu = u - ci;
        const a = cj * (GRID + 1) + ci;
        const b = a + GRID + 1;
        const sx = (fx[a] * (1 - tu) + fx[a + 1] * tu) * (1 - tv) + (fx[b] * (1 - tu) + fx[b + 1] * tu) * tv;
        const sy = (fy[a] * (1 - tu) + fy[a + 1] * tu) * (1 - tv) + (fy[b] * (1 - tu) + fy[b + 1] * tu) * tv;
        if (sx < 0 || sy < 0 || sx >= w0 || sy >= h0) continue;
        // Position in this level's window, bilinear between the four nearest pixels.
        const lx = Math.min(ww - 1, Math.max(0, sx / f - win[0] - 0.5));
        const ly = Math.min(wh - 1, Math.max(0, sy / f - win[1] - 0.5));
        const x0 = Math.floor(lx);
        const y0 = Math.floor(ly);
        const x1 = Math.min(ww - 1, x0 + 1);
        const y1 = Math.min(wh - 1, y0 + 1);
        const dx = lx - x0;
        const dy = ly - y0;
        const p00 = (y0 * ww + x0) * 4;
        const p10 = (y0 * ww + x1) * 4;
        const p01 = (y1 * ww + x0) * 4;
        const p11 = (y1 * ww + x1) * 4;
        const o = (j * TILE + i) * 4;
        for (let c = 0; c < 4; c++) {
          px[o + c] = (src[p00 + c] * (1 - dx) + src[p10 + c] * dx) * (1 - dy) + (src[p01 + c] * (1 - dx) + src[p11 + c] * dx) * dy;
        }
      }
    }
    return encode(out);
  }
}

// ---- the map side: tiles are asked for through a gtiff:// address ----

const providers = new Map<string, () => Promise<TiffTiles>>();
let installed = false;

/** Says how to get the tiles for a GeoTIFF; the file is opened the first time a tile is wanted. */
export function registerTiles(id: string, provider: () => Promise<TiffTiles>): void {
  providers.set(id, provider);
  if (!installed) {
    installed = true;
    maplibregl.addProtocol('gtiff', async (params) => {
      const [tileId, z, x, y] = params.url.slice('gtiff://'.length).split('/');
      const open = providers.get(tileId);
      if (!open) return { data: await transparentTile() };
      const tiles = await open();
      return { data: await tiles.renderTile(Number(z), Number(x), Number(y)) };
    });
  }
}

export const unregisterTiles = (id: string) => void providers.delete(id);
export const tileUrl = (id: string) => `gtiff://${id}/{z}/{x}/{y}`;
