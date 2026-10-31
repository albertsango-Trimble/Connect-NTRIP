/**
 * Finds a coordinate system in the EPSG registry (every projected system proj4 can use, built into the app,
 * so no internet is needed): by code, or by the name a Connect project reports for its coordinate system.
 * The data is loaded the first time it is needed.
 */

/** code, name, proj4 definition, country, bounds (north, west, south, east), approximate (a datum shift grid could not be used) */
type Row = [number, string, string, string, number[] | null, number];

export interface EpsgMatch {
  code: number;
  name: string;
  proj4: string;
  /** True when the definition has no datum shift (it needed a grid file), so positions can be off by up to a few metres */
  approximate: boolean;
}

let registry: Promise<Row[]> | undefined;
const load = () => (registry ??= import('../data/epsg-projected.json').then((m) => (m.default ?? m) as unknown as Row[]));

const toMatch = (r: Row): EpsgMatch => ({ code: r[0], name: r[1], proj4: r[2], approximate: r[5] === 1 });

export async function epsgByCode(code: number): Promise<EpsgMatch | null> {
  const row = (await load()).find((r) => r[0] === code);
  return row ? toMatch(row) : null;
}

/** Words that say nothing about which system it is. */
const STOP = new Set(['ntv2', 'grid', 'the', 'of', 'and', 'to', 'coordinate', 'system', 'projected', 'crs', 'epsg', 'datum', 'projection']);
/** Spellings and abbreviations Trimble names use that differ from EPSG names. */
const EXPAND: Record<string, string[]> = { gk: ['gauss', 'kruger'], krueger: ['kruger'], gauss: ['gauss'], lcc: ['lambert', 'conformal', 'conic'], tm: ['transverse', 'mercator'] };

function tokens(text: string): string[] {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter((w) => !STOP.has(w));
  return words.flatMap((w) => EXPAND[w] ?? [w]);
}

interface Index {
  rows: Row[];
  words: Set<string>[];
  weight: Map<string, number>;
}
let index: Promise<Index> | undefined;
const buildIndex = () =>
  (index ??= load().then((rows) => {
    const words = rows.map((r) => new Set(tokens(`${r[1]} ${r[3]}`)));
    const df = new Map<string, number>();
    words.forEach((set) => set.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
    const weight = new Map<string, number>();
    df.forEach((n, w) => weight.set(w, Math.log(1 + rows.length / n)));
    return { rows, words, weight };
  }));

/** Numbers in a name often are the zone or central meridian, which EPSG names may only give in the definition. */
const definitionNumbers = (proj4: string) => [...proj4.matchAll(/\+(?:zone|lon_0|lat_0)=(-?[\d.]+)/g)].map((m) => Math.abs(Number(m[1])));

/**
 * The registry entry a Connect coordinate system name most plausibly means, or null when it isn't clear enough.
 * Names are compared word by word (rarer words count for more); a match has to cover nearly everything the name says
 * and not be tied with a different system.
 */
export async function epsgByName(name: string): Promise<EpsgMatch | null> {
  const query = [...new Set(tokens(name))];
  if (query.length === 0) return null;
  const { rows, words, weight } = await buildIndex();
  const known = query.filter((w) => weight.has(w) || /^\d+(\.\d+)?$/.test(w));
  if (known.length === 0) return null;

  const scored: { row: Row; score: number; cov: number }[] = [];
  rows.forEach((row, i) => {
    const set = words[i];
    const numbers = definitionNumbers(row[2]);
    let hit = 0;
    let total = 0;
    for (const w of known) {
      const wt = weight.get(w) ?? 2; // numbers the registry never spells out still count a little
      total += wt;
      if (set.has(w) || (/^\d+(\.\d+)?$/.test(w) && numbers.some((n) => Math.abs(n - Number(w)) < 0.01))) hit += wt;
    }
    if (hit === 0) return;
    let candidateTotal = 0;
    set.forEach((w) => (candidateTotal += weight.get(w) ?? 0));
    const cov = hit / total;
    const prec = hit / Math.max(candidateTotal, hit);
    scored.push({ row, cov, score: (2 * cov * prec) / (cov + prec) });
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.cov < 0.85 || best.score < 0.5) return null;
  // A tie with a different definition means the name doesn't say which one.
  const rival = scored.find((s) => s.row[2] !== best.row[2]);
  if (rival && best.score - rival.score < 0.03) return null;
  return toMatch(best.row);
}
