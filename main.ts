// png-squeeze-01 entry: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Strategy (all deterministic, fixed work budgets, no clock/env reads):
//   1. Decode the stored input PNG to RGBA with our own decoder.
//   2. Analyse the image: opaque? grey? at most 256 distinct colours? one transparent key colour?
//   3. Build candidate forms: palette (count order / luminance order), grey / grey+alpha,
//      RGB / RGBA, with a tRNS key when the image allows it.
//   4. For each form, try filter strategies (fixed 0/1/2/4, per-row minimum-sum, per-row
//      brute-force trial deflate) and screen each by zlib level 6 size, PLTE/tRNS included.
//   5. Re-encode the winner with zlib level 9 (default + filtered strategies, memLevel 9)
//      and keep the smallest stream.
//   6. Write IHDR / PLTE / tRNS / IDAT / IEND only, CRCs correct, bit depth 8, no interlace.
//
// Local run on the practice set:
//   MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const N = W * H;

// ---------- PNG writing helpers ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    v.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    v.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------- PNG decoding (input is a stored colour-type-6 PNG, but decode generally) ----------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated size');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter type ' + ft);
  }
  const rgba = new Uint8Array(N * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < N; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < N; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < N; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < N; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- image analysis ----------

function analyse(rgba) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < N; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}

// One fully transparent value the image may key by tRNS instead of an alpha channel:
// every non-opaque pixel is alpha 0 of that exact value, and no opaque pixel uses it.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(N * ch);
  for (let i = 0, d = 0, s = 0; i < N; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  const indices = new Uint8Array(N);
  for (let i = 0; i < N; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---------- filtering ----------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;

// Filter `samples` (height rows of width*bpp) by `choice`: a fixed type, 'minsum' or
// 'brute' (each row the filter whose trial row compresses smallest by zlib level 4
// after the 32 KiB written before it). Writes into a fresh buffer.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    const before = choice === 'brute' ? raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at) : null;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- candidate forms ----------

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'brute'] });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

// Screen every form/filter choice by zlib level 6 size; return the winner's form + filtered data.
function screen(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  return best;
}

// Re-encode the winner's filtered data: the optimal parser first (zopfli-style), with
// zlib level 9 under a few strategies as a safety net; keep the smallest stream.
function finalDeflate(data) {
  let best = null;
  try {
    const z = optimalDeflate(data);
    if (best === null || z.length < best.length) best = z;
  } catch {
    // fall through to zlib
  }
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_RLE]) {
    const z = deflateSync(data, { level: 9, memLevel: 9, strategy });
    if (best === null || z.length < best.length) best = z;
  }
  return best;
}

function encode(rgba, width, height) {
  const { form, data } = screen(rgba, width, height);
  const idat = finalDeflate(data);
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Optimal-parse deflate (zopfli-style, simplified): longest-match LZ77 with hash chains,
// dynamic-programming parse under a Huffman bit-cost model iterated to convergence,
// length-limited Huffman codes (zlib's overflow method), per-block dynamic headers.
// Deterministic: fixed work budgets, no clock reads. One zlib stream out.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Uint8Array(259);
const DIST_SYM = new Uint8Array(32769);
{
  for (let s = 0; s < 29; s++) {
    const top = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
    for (let l = LEN_BASE[s]; l <= top; l++) LEN_SYM[l] = s;
  }
  for (let s = 0; s < 30; s++) {
    const top = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
    for (let d = DIST_BASE[s]; d <= top; d++) DIST_SYM[d] = s;
  }
}

const BLOCK = 131072;
const CHAIN = 128;

// ---------- Huffman code lengths (zlib's method) ----------

function codeLengths(freqs, maxLen) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  let nodes = syms.map((s) => ({ f: freqs[s], s, l: null, r: null }));
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.f - b.f || (a.s < 0 ? 1e9 : a.s) - (b.s < 0 ? 1e9 : b.s));
    const a = nodes.shift();
    const b = nodes.shift();
    nodes.push({ f: a.f + b.f, s: -1, l: a, r: b });
  }
  const depths = new Uint8Array(n);
  const walk = (nd, d) => {
    if (nd.s >= 0) depths[nd.s] = d;
    else {
      walk(nd.l, d + 1);
      walk(nd.r, d + 1);
    }
  };
  walk(nodes[0], 0);
  const blCount = new Array(maxLen + 1).fill(0);
  let overflow = 0;
  for (const s of syms) {
    if (depths[s] > maxLen) {
      // zlib's method: clamp the overflowing length into the max-length bucket
      // and count it as overflow; the loop below moves it down the tree.
      overflow++;
      blCount[maxLen]++;
    } else {
      blCount[depths[s]]++;
    }
  }
  if (overflow === 0) {
    for (const s of syms) lengths[s] = depths[s];
    return lengths;
  }
  do {
    let m = maxLen - 1;
    while (blCount[m] === 0) m--;
    blCount[m]--;
    blCount[m + 1] += 2;
    blCount[maxLen]--;
    overflow -= 2;
  } while (overflow > 0);
  const sorted = [...syms].sort((a, b) => freqs[b] - freqs[a] || a - b);
  let idx = 0;
  for (let d = 1; d <= maxLen; d++) {
    for (let k = 0; k < blCount[d]; k++) lengths[sorted[idx++]] = d;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l) {
      codes[s] = nextCode[l];
      nextCode[l]++;
    }
  }
  return codes;
}

// ---------- bit writer ----------

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  putBit(b) {
    this.acc |= (b & 1) << this.nbits;
    if (++this.nbits === 8) {
      this.bytes.push(this.acc);
      this.acc = 0;
      this.nbits = 0;
    }
  }
  putBits(value, len) {
    for (let i = 0; i < len; i++) this.putBit((value >> i) & 1);
  }
  putCode(code, len) {
    for (let i = len - 1; i >= 0; i--) this.putBit((code >> i) & 1);
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.acc);
    return Uint8Array.from(this.bytes);
  }
}

// ---------- match finding ----------

function findMatches(data) {
  const n = data.length;
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  // Per position: the longest match, the closest match of length >= 3, and the
  // longest match within distance 2048. A long match far away often costs more
  // bits than a slightly shorter one nearby, so the parser needs all three.
  const matchLen = new Uint16Array(n);
  const matchDist = new Int32Array(n);
  const shortLen = new Uint16Array(n);
  const shortDist = new Int32Array(n);
  const nearLen = new Uint16Array(n);
  const nearDist = new Int32Array(n);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + 2 < n; i++) {
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0xffff;
    let cand = head[h];
    if (cand >= 0) {
      const maxLen = Math.min(258, n - i);
      let bestLen = 2;
      let bestDist = 0;
      let sLen = 0;
      let sDist = 0;
      let nLen = 2;
      let nDist = 0;
      let steps = 0;
      while (cand >= 0 && steps < CHAIN) {
        steps++;
        const dist = i - cand;
        if (dist > 32768) break;
        // Compute the length when this candidate could beat the longest match,
        // the closest match, or the longest nearby match.
        if (data[cand + bestLen] === data[i + bestLen]
          || ((sLen === 0 || dist < sDist) && data[cand + 2] === data[i + 2])
          || (dist <= 2048 && data[cand + nLen] === data[i + nLen])) {
          let len = 0;
          while (len + 4 <= maxLen && dv.getUint32(cand + len, true) === dv.getUint32(i + len, true)) len += 4;
          while (len < maxLen && data[cand + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = dist;
            if (len >= maxLen) break;
          }
          if (len >= 3 && (sLen === 0 || dist < sDist)) {
            sLen = len;
            sDist = dist;
          }
          if (dist <= 2048 && len > nLen) {
            nLen = len;
            nDist = dist;
          }
        }
        cand = prev[cand];
      }
      if (bestLen >= 3) {
        matchLen[i] = bestLen;
        matchDist[i] = bestDist;
      }
      if (sLen >= 3) {
        shortLen[i] = sLen;
        shortDist[i] = sDist;
      }
      if (nLen >= 3) {
        nearLen[i] = nLen;
        nearDist[i] = nDist;
      }
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { matchLen, matchDist, shortLen, shortDist, nearLen, nearDist };
}

// ---------- dynamic programming parse of one block ----------

function parseBlock(data, start, end, M, litCost, lenCost, distCostTable) {
  const m = end - start;
  const cost = new Float64Array(m + 1);
  for (let i = 0; i <= m; i++) cost[i] = Infinity;
  const choice = new Int16Array(m + 1);
  const choiceDist = new Int32Array(m + 1);
  cost[0] = 0;
  for (let i = 0; i < m; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const pos = start + i;
    const lc = c + litCost[data[pos]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      choice[i + 1] = 0;
    }
    // Up to three match options at this position; for each, the lengths from
    // its length down to three shorter.
    for (let o = 0; o < 3; o++) {
      const ml = o === 0 ? M.matchLen[pos] : o === 1 ? M.shortLen[pos] : M.nearLen[pos];
      if (ml < 3) continue;
      const md = o === 0 ? M.matchDist[pos] : o === 1 ? M.shortDist[pos] : M.nearDist[pos];
      if (o > 0 && ml === M.matchLen[pos] && md === M.matchDist[pos]) continue;
      const maxL = Math.min(ml, end - pos);
      const dc = distCostTable[md];
      const lo = Math.max(3, maxL - 3);
      for (let l = maxL; l >= lo; l--) {
        const mc = c + lenCost[l] + dc;
        if (mc < cost[i + l]) {
          cost[i + l] = mc;
          choice[i + l] = l;
          choiceDist[i + l] = md;
        }
      }
    }
  }
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  const ops = [];
  let i = m;
  while (i > 0) {
    const l = choice[i];
    if (l === 0) {
      const s = data[start + i - 1];
      ops.push(s);
      litFreq[s]++;
      i--;
    } else {
      const d = choiceDist[i];
      ops.push(-(l * 65536 + d));
      litFreq[257 + LEN_SYM[l]]++;
      distFreq[DIST_SYM[d]]++;
      i -= l;
    }
  }
  ops.reverse();
  litFreq[256]++;
  return { ops, litFreq, distFreq };
}

// ---------- dynamic block emission ----------

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function rleLengths(lengths) {
  const tokens = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 3) {
        if (left >= 11) {
          const take = Math.min(left, 138);
          tokens.push([18, take - 11, 7]);
          left -= take;
        } else {
          const take = Math.min(left, 10);
          tokens.push([17, take - 3, 3]);
          left -= take;
        }
      }
      for (let k = 0; k < left; k++) tokens.push([0]);
    } else {
      tokens.push([v]);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        tokens.push([16, take - 3, 2]);
        left -= take;
      }
      for (let k = 0; k < left; k++) tokens.push([v]);
    }
    i += run;
  }
  return tokens;
}

function emitDynamicBlock(bw, bfinal, ops, litLengths, distLengths) {
  let hlit = 288;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  const allLengths = new Uint8Array(hlit + hdist);
  allLengths.set(litLengths.subarray(0, hlit), 0);
  allLengths.set(distLengths.subarray(0, hdist), hlit);
  const tokens = rleLengths(allLengths);
  const clFreq = new Float64Array(19);
  for (const [s] of tokens) clFreq[s]++;
  const clLengths = codeLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLengths);
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);
  bw.putBits(bfinal ? 1 : 0, 1);
  bw.putBits(2, 2);
  bw.putBits(hlit - 257, 5);
  bw.putBits(hdist - 1, 5);
  bw.putBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.putBits(clLengths[CL_ORDER[k]], 3);
  for (const [s, extra, bits] of tokens) {
    bw.putCode(clCodes[s], clLengths[s]);
    if (bits) bw.putBits(extra, bits);
  }
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op >= 0) {
      bw.putCode(litCodes[op], litLengths[op]);
    } else {
      const v = -op;
      const len = (v / 65536) | 0;
      const dist = v % 65536;
      const ls = LEN_SYM[len];
      bw.putCode(litCodes[257 + ls], litLengths[257 + ls]);
      if (LEN_EXTRA[ls]) bw.putBits(len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = DIST_SYM[dist];
      bw.putCode(distCodes[ds], distLengths[ds]);
      if (DIST_EXTRA[ds]) bw.putBits(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.putCode(litCodes[256], litLengths[256]);
}

// Fixed-Huffman bit costs (for the first cost model and the fixed-block comparison).
const FIXED_LIT_COST = new Float64Array(288);
const FIXED_DIST_COST = new Float64Array(30);
{
  for (let s = 0; s < 288; s++) FIXED_LIT_COST[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  FIXED_DIST_COST.fill(5);
}

function costsFromLengths(litLengths, distLengths) {
  const litCost = new Float64Array(288);
  const lenCost = new Float64Array(259);
  for (let s = 0; s < 288; s++) litCost[s] = litLengths[s] || 15;
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYM[l];
    lenCost[l] = litCost[257 + s] + LEN_EXTRA[s];
  }
  const distTable = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = DIST_SYM[d];
    distTable[d] = (distLengths[s] || 15) + DIST_EXTRA[s];
  }
  return { litCost, lenCost, distTable };
}

function fixedCosts() {
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYM[l];
    lenCost[l] = FIXED_LIT_COST[257 + s] + LEN_EXTRA[s];
  }
  const distTable = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = DIST_SYM[d];
    distTable[d] = 5 + DIST_EXTRA[s];
  }
  return { litCost: FIXED_LIT_COST, lenCost, distTable };
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of `data` (Uint8Array) from the optimal parser. */
export function optimalDeflate(data) {
  const M = findMatches(data);
  const bw = new BitWriter();
  const n = data.length;
  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK);
    const bfinal = end === n ? 1 : 0;
    // Iteration 1: fixed costs.
    let fc = fixedCosts();
    let p = parseBlock(data, start, end, M, fc.litCost, fc.lenCost, fc.distTable);
    // Iterations 2-3: dynamic costs from the previous parse's frequencies.
    for (let it = 0; it < 2; it++) {
      const litLengths = codeLengths(p.litFreq, 15);
      const distLengths = codeLengths(p.distFreq, 15);
      if (p.distFreq.every((f) => f === 0)) distLengths[0] = 1;
      const c = costsFromLengths(litLengths, distLengths);
      p = parseBlock(data, start, end, M, c.litCost, c.lenCost, c.distTable);
    }
    const litLengths = codeLengths(p.litFreq, 15);
    const distLengths = codeLengths(p.distFreq, 15);
    if (p.distFreq.every((f) => f === 0)) distLengths[0] = 1;
    emitDynamicBlock(bw, bfinal, p.ops, litLengths, distLengths);
  }
  const body = bw.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// ---------- main ----------

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (image.width !== W || image.height !== H) throw new Error(`${id}: unexpected size ${image.width}x${image.height}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encode(image.rgba, image.width, image.height));
}
