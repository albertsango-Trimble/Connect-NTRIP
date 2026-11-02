// Works out what a base is sending by looking at the bytes, so a base can pick its own mountpoint
// without the format being configured. Data is still relayed untouched.
//
// RTCM 3: frames start 0xD3, checked with CRC-24Q (see rtcm.js). Base position from 1005/1006.
// CMR (packet type 0x93): base position from message Type 1, decoded per Talbot, "Compact Data
//   Transmission Standard for High-Precision GPS" (Trimble, 1996), Appendix A, Table A.6.
// Trimble CMR family: STX(0x02) status type length data[length] checksum ETX(0x03),
//   checksum = (status + type + length + data) mod 256.
//   Type 0x93 = CMR / CMR+, 0x94 = CMR+ (separate type on some firmware), 0x98 = CMRx.
import { RtcmMonitor, ecefToLla } from './rtcm.js';

const CMR_TYPES = { 0x93: 'CMR/CMR+', 0x94: 'CMR+', 0x98: 'CMRx' };
const MIN_FRAMES = 3;
const CMR_ACCURACY = ['unknown', '5 km', '1 km', '500 m', '100 m', '50 m', '10 m', '5 m', '1 m', '50 cm', '10 cm', '5 cm', '1 cm', '5 mm', '1 mm', 'exact'];

/** Unsigned bit field, MSB first. */
function bitsU(buf, pos, len) {
  let v = 0;
  for (let i = pos; i < pos + len; i++) v = v * 2 + ((buf[i >> 3] >> (7 - (i & 7))) & 1);
  return v;
}
/** Signed bit field: two's complement, or sign-and-magnitude ("N bits (1 sign)" in the spec). */
function bitsS(buf, pos, len, signMagnitude = false) {
  const u = bitsU(buf, pos, len);
  const half = 2 ** (len - 1);
  if (u < half) return u;
  return signMagnitude ? -(u - half) : u - 2 ** len;
}

/**
 * CMR Type 1 data block (152 bits after the 48-bit header): ECEF X 34, antenna height 14, ECEF Y 34,
 * east offset 14, ECEF Z 34, north offset 14 (all mm, signed), position accuracy 4, reserved 4.
 * The spec writes the signed fields as "34 (1 sign)", which could mean two's complement or
 * sign-and-magnitude; only one gives a point on the Earth's surface, so both are tried.
 */
export function decodeCmrType1(data) {
  if (data.length < 25 || bitsU(data, 8, 3) !== 1) return null;
  const at = 48;
  for (const sm of [false, true]) {
    const x = bitsS(data, at, 34, sm) / 1000;
    const antennaHeight = bitsS(data, at + 34, 14, sm) / 1000;
    const y = bitsS(data, at + 48, 34, sm) / 1000;
    const east = bitsS(data, at + 82, 14, sm) / 1000;
    const z = bitsS(data, at + 96, 34, sm) / 1000;
    const north = bitsS(data, at + 130, 14, sm) / 1000;
    const r = Math.hypot(x, y, z);
    if (r < 6.30e6 || r > 6.42e6) continue; // not on Earth: try the other sign convention
    const accuracy = CMR_ACCURACY[bitsU(data, at + 144, 4)];
    return {
      stationId: bitsU(data, 3, 5),
      ecef: { x, y, z },
      antennaHeight, offsetEast: east, offsetNorth: north, accuracy,
      ...ecefToLla(x, y, z),
      from: 'CMR Type 1',
    };
  }
  return null;
}

// RTCM 3 message numbers that identify the standard's version and the MSM level.
// MSM blocks: GPS 1071-77, GLONASS 1081-87, Galileo 1091-97, SBAS 1101-07, QZSS 1111-17, BeiDou 1121-27, NavIC 1131-37;
// the last digit is the MSM level (MSM1-MSM7).
// Messages added in RTCM 3.3 (10403.3): QZSS, BeiDou and NavIC MSM (1111-1137) and ephemerides 1041/1042/1044/1046.
const RTCM33 = new Set([1041, 1042, 1044, 1046]);
export const isMsm = t => t >= 1071 && t <= 1137 && t % 10 >= 1 && t % 10 <= 7;

/** e.g. "RTCM 3.3 · MSM4", worked out from the message types seen. */
export function rtcmLabel(types) {
  const msm = types.filter(isMsm);
  let version;
  if (types.some(t => RTCM33.has(t) || (isMsm(t) && t >= 1111))) version = '3.3';
  else if (msm.length || types.includes(1230)) version = '3.2';
  else version = '3.x';
  const levels = [...new Set(msm.map(t => t % 10))].sort();
  return `RTCM ${version}${levels.length ? ` · MSM${levels.join('/')}` : ''}`;
}

export class FormatMonitor {
  constructor() {
    this.rtcm = new RtcmMonitor();
    this.cmr = new Map(); // type byte -> count
    this.cmrFrames = 0;
    this.buf = Buffer.alloc(0);
    this.cmrStation = null;
  }

  /** Base position from the data itself: RTCM 1005/1006, otherwise CMR Type 1. */
  get station() {
    if (this.rtcm.station) return { ...this.rtcm.station, from: 'RTCM 1005/1006' };
    return this.cmrStation;
  }
  messageTypes() { return this.rtcm.messageTypes(); }

  push(data) {
    this.rtcm.push(data);
    // Keep reading CMR frames: the Type 1 position message comes every few seconds
    if (this.rtcm.frames < MIN_FRAMES || this.cmrFrames > 0) this.scanCmr(data);
  }

  scanCmr(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    let i = 0;
    for (;;) {
      const s = this.buf.indexOf(0x02, i);
      if (s < 0) { i = this.buf.length; break; }
      if (this.buf.length - s < 4) { i = s; break; }
      const len = this.buf[s + 3];
      const end = s + 4 + len + 2;
      if (this.buf.length < end) { i = s; break; }
      let sum = 0;
      for (let k = s + 1; k < s + 4 + len; k++) sum = (sum + this.buf[k]) & 0xff;
      if (sum === this.buf[s + 4 + len] && this.buf[end - 1] === 0x03) {
        const type = this.buf[s + 2];
        this.cmr.set(type, (this.cmr.get(type) || 0) + 1);
        this.cmrFrames++;
        if (type === 0x93) {
          const pos = decodeCmrType1(this.buf.subarray(s + 4, s + 4 + len));
          if (pos) this.cmrStation = pos;
        }
        i = end;
      } else {
        i = s + 1;
      }
    }
    this.buf = this.buf.subarray(i);
    if (this.buf.length > 4096) this.buf = this.buf.subarray(this.buf.length - 270);
  }

  /** The format name, or null until enough frames have been seen. */
  detected() {
    if (this.rtcm.frames >= MIN_FRAMES && this.rtcm.frames >= this.cmrFrames) {
      return rtcmLabel(this.rtcm.messageTypes());
    }
    if (this.cmrFrames >= MIN_FRAMES) {
      const [type] = [...this.cmr.entries()].sort((a, b) => b[1] - a[1])[0];
      return CMR_TYPES[type] || `CMR (type 0x${type.toString(16)})`;
    }
    return null;
  }
}
