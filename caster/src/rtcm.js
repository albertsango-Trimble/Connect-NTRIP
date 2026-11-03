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
  // Ignore positions that aren't on the Earth's surface (an empty or corrupt message)
  const r = Math.hypot(x, y, z);
  if (!(r > 6.30e6 && r < 6.42e6)) return null;
  return { stationId, ecef: { x, y, z }, antennaHeight, ...ecefToLla(x, y, z) };
}

// GPS time of week now, in ms (GPS time runs ahead of UTC by the leap seconds, 18 since 2017)
const GPS_EPOCH = Date.UTC(1980, 0, 6);
const WEEK = 604_800_000;
const LEAP_MS = 18_000;
const gpsTowNow = now => (now - GPS_EPOCH + LEAP_MS) % WEEK;
// MSM messages whose epoch time is a time of week: GPS, Galileo, QZSS (GPS time) and BeiDou (14 s behind GPS)
const towOffset = t => (t >= 1071 && t <= 1077) || (t >= 1091 && t <= 1097) || (t >= 1111 && t <= 1117) ? 0 : t >= 1121 && t <= 1127 ? 14_000 : null;

export class RtcmMonitor {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.types = new Map(); // type -> count since last reset
    this.frames = 0;
    this.station = null;
    this.crcErrors = 0;
    // How late each epoch arrives (from the GNSS time in MSM messages), and epochs missed
    this.latency = []; // recent samples, ms
    this.lastEpoch = null;
    this.interval = null; // usual time between epochs, ms
    this.epochs = 0;
    this.missed = 0;
  }

  /** Called for each MSM message: times the epoch the first time it is seen. */
  epoch(type, payload, at) {
    const off = towOffset(type);
    if (off === null) return;
    const tow = (getBitsU(payload, 24, 30) + off) % WEEK;
    if (tow === this.lastEpoch) return; // other messages of the same epoch
    let late = gpsTowNow(at) - tow;
    if (late < -WEEK / 2) late += WEEK;
    if (late > WEEK / 2) late -= WEEK;
    // Ignore data that isn't live (a replay, or a receiver or server clock that's badly out)
    if (late > -2000 && late < 120_000) {
      this.latency.push(Math.max(0, late));
      if (this.latency.length > 60) this.latency.shift();
    }
    if (this.lastEpoch !== null) {
      let step = tow - this.lastEpoch;
      if (step < 0) step += WEEK;
      if (step > 0 && step < 60_000) {
        // The base's output rate is the shortest step among the last 20 (1 Hz bases: 1000 ms); longer steps are missed epochs
        (this.steps ??= []).push(step);
        if (this.steps.length > 20) this.steps.shift();
        this.interval = Math.max(50, Math.min(...this.steps));
        const gap = Math.round(step / this.interval) - 1;
        if (gap > 0 && gap < 600) this.missed += gap;
      }
    }
    this.lastEpoch = tow;
    this.epochs++;
  }

  /** Recent delay from the base's epoch time to its arrival here: { avgMs, maxMs } or null. */
  latencyStats() {
    if (!this.latency.length) return null;
    const recent = this.latency.slice(-30);
    return { avgMs: Math.round(recent.reduce((a, b) => a + b, 0) / recent.length), maxMs: Math.round(Math.max(...recent)), lastMs: Math.round(recent[recent.length - 1]) };
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
        if (type === 1005 || type === 1006) this.station = decodeStationPosition(payload) || this.station;
        else if (type >= 1071 && type <= 1137) this.epoch(type, payload, Date.now());
        i = s + total;
      } else {
        // A frame header whose check fails: corrupted data (counted only once the stream is known to be RTCM)
        if (this.frames > 10 && len >= 2) this.crcErrors++;
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
