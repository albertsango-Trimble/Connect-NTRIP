// HTTP/1.1 chunked transfer encoding, used by NTRIP 2.0.

export function encodeChunk(data) {
  return Buffer.concat([Buffer.from(data.length.toString(16) + '\r\n'), data, Buffer.from('\r\n')]);
}

export class ChunkDecoder {
  constructor() {
    this.state = 'size';
    this.line = '';
    this.remaining = 0;
    this.done = false;
  }

  /** Returns the decoded payload bytes contained in buf. Throws on malformed input. */
  push(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length && !this.done) {
      if (this.state === 'size') {
        const b = buf[i++];
        if (b === 0x0a) {
          const n = parseInt(this.line.split(';')[0].trim(), 16);
          this.line = '';
          if (Number.isNaN(n)) throw new Error('bad chunk size');
          if (n === 0) { this.done = true; break; }
          this.remaining = n;
          this.state = 'data';
        } else if (b !== 0x0d) {
          this.line += String.fromCharCode(b);
          if (this.line.length > 32) throw new Error('bad chunk header');
        }
      } else if (this.state === 'data') {
        const take = Math.min(this.remaining, buf.length - i);
        out.push(buf.subarray(i, i + take));
        i += take;
        this.remaining -= take;
        if (this.remaining === 0) this.state = 'crlf';
      } else {
        if (buf[i++] === 0x0a) this.state = 'size';
      }
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }
}
