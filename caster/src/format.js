// Works out what a base is sending by looking at the bytes, so a base can pick its own mountpoint
// without the format being configured. Data is still relayed untouched.
//
// RTCM 3: frames start 0xD3, checked with CRC-24Q (see rtcm.js).
// Trimble CMR family: STX(0x02) status type length data[length] checksum ETX(0x03),
//   checksum = (status + type + length + data) mod 256.
//   Type 0x93 = CMR / CMR+, 0x94 = CMR+ (separate type on some firmware), 0x98 = CMRx.
import { RtcmMonitor } from './rtcm.js';

const CMR_TYPES = { 0x93: 'CMR/CMR+', 0x94: 'CMR+', 0x98: 'CMRx' };
const MIN_FRAMES = 3;

export class FormatMonitor {
  constructor() {
    this.rtcm = new RtcmMonitor();
    this.cmr = new Map(); // type byte -> count
    this.cmrFrames = 0;
    this.buf = Buffer.alloc(0);
  }

  get station() { return this.rtcm.station; }
  messageTypes() { return this.rtcm.messageTypes(); }

  push(data) {
    this.rtcm.push(data);
    // CMR detection is only needed until the format is known
    if (this.cmrFrames < 50) this.scanCmr(data);
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
      const types = this.rtcm.messageTypes();
      const msm = types.some(t => (t >= 1071 && t <= 1137));
      return msm ? 'RTCM 3.2' : 'RTCM 3';
    }
    if (this.cmrFrames >= MIN_FRAMES) {
      const [type] = [...this.cmr.entries()].sort((a, b) => b[1] - a[1])[0];
      return CMR_TYPES[type] || `CMR (type 0x${type.toString(16)})`;
    }
    return null;
  }
}
