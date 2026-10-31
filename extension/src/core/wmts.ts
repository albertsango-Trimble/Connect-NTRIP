export interface WmtsLayer {
  identifier: string;
  title: string;
  format: string;
  tileMatrixSet: string | null;
  style: string;
  /** RESTful tile template from the capabilities document, if the layer has one */
  template: string | null;
  /** Layer extent in WGS84 degrees */
  bbox: { west: number; south: number; east: number; north: number } | null;
}

export interface WmtsCapabilities {
  layers: WmtsLayer[];
  /** KVP GetTile endpoint, used when a layer has no RESTful template */
  kvpBase: string | null;
}

const XLINK = 'http://www.w3.org/1999/xlink';

const text = (el: Element, tag: string): string | null =>
  el.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() || null;

/** Parses a WMTS GetCapabilities document. Throws if it isn't valid XML or has no layers. */
export function parseCapabilities(xml: string): WmtsCapabilities {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('the response was not valid XML. Check it is a GetCapabilities URL');
  }

  const layers: WmtsLayer[] = [];
  for (const el of Array.from(doc.getElementsByTagNameNS('*', 'Layer'))) {
    const identifier = text(el, 'Identifier');
    if (!identifier) continue;

    const styleEl = el.getElementsByTagNameNS('*', 'Style')[0];
    const resourceUrl = Array.from(el.getElementsByTagNameNS('*', 'ResourceURL')).find(
      (r) => r.getAttribute('resourceType') === 'tile',
    );

    let bbox: WmtsLayer['bbox'] = null;
    const bboxEl = el.getElementsByTagNameNS('*', 'WGS84BoundingBox')[0];
    if (bboxEl) {
      const lower = text(bboxEl, 'LowerCorner')?.split(/\s+/).map(Number);
      const upper = text(bboxEl, 'UpperCorner')?.split(/\s+/).map(Number);
      if (lower && upper && [...lower, ...upper].every(Number.isFinite)) {
        bbox = { west: lower[0], south: lower[1], east: upper[0], north: upper[1] };
      }
    }

    layers.push({
      identifier,
      title: text(el, 'Title') ?? identifier,
      format: text(el, 'Format') ?? 'image/png',
      tileMatrixSet: text(el, 'TileMatrixSet'),
      style: styleEl ? (text(styleEl, 'Identifier') ?? '') : '',
      template: resourceUrl?.getAttribute('template') ?? null,
      bbox,
    });
  }
  if (layers.length === 0) throw new Error('no layers found in this capabilities document');

  let kvpBase: string | null = null;
  const getTile = Array.from(doc.getElementsByTagNameNS('*', 'Operation')).find((o) => o.getAttribute('name') === 'GetTile');
  const get = getTile?.getElementsByTagNameNS('*', 'Get')[0];
  if (get) kvpBase = get.getAttributeNS(XLINK, 'href') || get.getAttribute('href');

  return { layers, kvpBase };
}

/** Converts WMTS placeholders to the {z}/{x}/{y} form that the map expects. */
export function normalizeTemplate(url: string): string {
  return url
    .replace(/\{TileMatrix\}/gi, '{z}')
    .replace(/\{TileCol\}/gi, '{x}')
    .replace(/\{TileRow\}/gi, '{y}');
}

/** True if the text is a tile URL template (has zoom, column and row placeholders). */
export function isTileTemplate(url: string): boolean {
  return /\{(z|TileMatrix)\}/i.test(url) && /\{(x|TileCol)\}/i.test(url) && /\{(y|TileRow)\}/i.test(url);
}

/**
 * Builds a {z}/{x}/{y} tile URL for a layer, or null if the capabilities give no way to.
 * Assumes a Web Mercator tile matrix set whose matrix ids are the zoom levels (0, 1, 2...),
 * such as GoogleMapsCompatible. Sets with prefixed ids like "EPSG:3857:12" will not line up.
 */
export function buildTileUrl(layer: WmtsLayer, kvpBase: string | null): string | null {
  if (layer.template) return normalizeTemplate(layer.template);
  if (kvpBase && layer.tileMatrixSet) {
    const sep = kvpBase.includes('?') ? '&' : '?';
    const q = encodeURIComponent;
    return (
      `${kvpBase}${sep}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${q(layer.identifier)}` +
      `&STYLE=${q(layer.style)}&TILEMATRIXSET=${q(layer.tileMatrixSet)}` +
      `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${q(layer.format)}`
    );
  }
  return null;
}
