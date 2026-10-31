// Minimal RTCM 3 framer. Used only for monitoring: counting message types and
// reading the base antenna position from 1005/1006. Data is relayed untouched.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 16;
  for (let j = 0; j < 8; j++) {
    c <<= 1;
    if (c & 0x1000000) c ^= 0x1864cfb;
  }
  CRC_TABLE[i] = c & 0xffffff;
}

export function crc24q(buf, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xffffff) ^ CRC_TABLE[((crc >>> 16) ^ buf[i]) & 0xff];
  }
  return crc;
}

function getBitsU(buf, pos, len) {
  let v = 0;
  for (let i = pos; i < pos + len; i++) {
    v = v * 2 + ((buf[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return v;
}

function getBitsS(buf, pos, len) {
  const v = getBitsU(buf, pos, len);
  const half = 2 ** (len - 1);
  return v >= half ? v - 2 ** len : v;
}

export function ecefToLla(x, y, z) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (e2 * N) / (N + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, h };
}

export function decodeStationPosition(payload) {
  const type = getBitsU(payload, 0, 12);
  if (type !== 1005 && type !== 1006) return null;
  const stationId = getBitsU(payload, 12, 12);
  const x = getBitsS(payload, 34, 38) * 0.0001;
  const y = getBitsS(payload, 74, 38) * 0.0001;
  const z = getBitsS(payload, 114, 38) * 0.0001;
  const antennaHeight = type === 1006 ? getBitsU(payload, 152, 16) * 0.0001 : null;
  return { stationId, ecef: { x, y, z }, antennaHeight, ...ecefToLla(x, y, z) };
}

export class RtcmMonitor {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.types = new Map(); // type -> count since last reset
    this.frames = 0;
    this.station = null;
  }

  push(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    let i = 0;
    for (;;) {
      const s = this.buf.indexOf(0xd3, i);
      if (s < 0) { i = this.buf.length; break; }
      if (this.buf.length - s < 3) { i = s; break; }
      const len = ((this.buf[s + 1] & 0x03) << 8) | this.buf[s + 2];
      const total = len + 6;
      if (this.buf.length - s < total) { i = s; break; }
      if (len >= 2 && crc24q(this.buf, s, s + len + 3) === this.buf.readUIntBE(s + len + 3, 3)) {
        const payload = this.buf.subarray(s + 3, s + 3 + len);
        const type = getBitsU(payload, 0, 12);
        this.types.set(type, (this.types.get(type) || 0) + 1);
        this.frames++;
        if (type === 1005 || type === 1006) this.station = decodeStationPosition(payload);
        i = s + total;
      } else {
        i = s + 1;
      }
    }
    this.buf = this.buf.subarray(i);
    if (this.buf.length > 8192) this.buf = this.buf.subarray(this.buf.length - 1029);
  }

  messageTypes() {
    return [...this.types.keys()].sort((a, b) => a - b);
  }
}
