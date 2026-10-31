// Extracts and parses NMEA GGA sentences that rovers send back to the caster.

const GGA_RE = /\$[A-Z]{2}GGA,[^\r\n$*]*\*[0-9A-Fa-f]{2}/g;

export const FIX_NAMES = {
  0: 'No fix', 1: 'Autonomous', 2: 'DGPS', 3: 'PPS', 4: 'RTK fixed',
  5: 'RTK float', 6: 'Dead reckoning', 7: 'Manual', 8: 'Simulator', 9: 'SBAS',
};

function checksumOk(sentence) {
  const star = sentence.lastIndexOf('*');
  let cs = 0;
  for (let i = 1; i < star; i++) cs ^= sentence.charCodeAt(i);
  return cs === parseInt(sentence.slice(star + 1, star + 3), 16);
}

function dm(value, hemi, degDigits) {
  if (!value) return null;
  const deg = parseInt(value.slice(0, degDigits), 10);
  const min = parseFloat(value.slice(degDigits));
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  const v = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -v : v;
}

export function parseGga(sentence) {
  if (!checksumOk(sentence)) return null;
  const f = sentence.slice(0, sentence.lastIndexOf('*')).split(',');
  const quality = parseInt(f[6], 10) || 0;
  const lat = dm(f[2], f[3], 2);
  const lon = dm(f[4], f[5], 3);
  const alt = parseFloat(f[9]);
  const sep = parseFloat(f[11]);
  return {
    utc: f[1] || null,
    lat, lon,
    hasPosition: quality > 0 && lat !== null && lon !== null && !(lat === 0 && lon === 0),
    quality,
    fix: FIX_NAMES[quality] || `Quality ${quality}`,
    sats: parseInt(f[7], 10) || 0,
    hdop: parseFloat(f[8]) || null,
    alt: Number.isNaN(alt) ? null : alt,
    geoidSep: Number.isNaN(sep) ? null : sep,
    ageOfCorrections: f[13] ? parseFloat(f[13]) : null,
    refStationId: f[14] || null,
  };
}

/** Stateful scanner: feed raw bytes from a rover, get back any complete GGA sentences. */
export class GgaScanner {
  constructor() { this.tail = ''; }
  push(buf) {
    const text = this.tail + buf.toString('latin1');
    const found = [];
    let lastEnd = 0;
    for (const m of text.matchAll(GGA_RE)) {
      const parsed = parseGga(m[0]);
      if (parsed) found.push(parsed);
      lastEnd = m.index + m[0].length;
    }
    // keep a little unconsumed text in case a sentence is split across packets
    const rest = text.slice(lastEnd);
    const dollar = rest.lastIndexOf('$');
    this.tail = dollar >= 0 ? rest.slice(dollar).slice(-200) : '';
    return found;
  }
}
