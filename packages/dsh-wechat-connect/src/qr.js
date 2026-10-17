"use strict";
/**
 * Self-contained QR Code encoder (byte mode, versions 1-10, EC levels L/M/Q/H).
 *
 * Implemented from the public QR Code specification (ISO/IEC 18004) so the
 * tool has no third-party dependencies. Version 10 at level M holds 213 bytes,
 * which is far more than the ~90-byte WeChat login URL needs; payloads that
 * exceed that range are reported as an explicit error instead of being
 * silently truncated.
 */

// ---- Galois field GF(256) with primitive polynomial 0x11D -------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the requested degree. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Compute `ecLen` Reed-Solomon parity bytes for `data`. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return res.slice(data.length);
}

// ---- Version / block tables (versions 1-10) --------------------------------

// EC level indicator bits used in the format information.
const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// version -> level -> { ec, groups: [[blockCount, dataCodewords], ...] }
const BLOCKS = {
  1: { L: { ec: 7, groups: [[1, 19]] }, M: { ec: 10, groups: [[1, 16]] }, Q: { ec: 13, groups: [[1, 13]] }, H: { ec: 17, groups: [[1, 9]] } },
  2: { L: { ec: 10, groups: [[1, 34]] }, M: { ec: 16, groups: [[1, 28]] }, Q: { ec: 22, groups: [[1, 22]] }, H: { ec: 28, groups: [[1, 16]] } },
  3: { L: { ec: 15, groups: [[1, 55]] }, M: { ec: 26, groups: [[1, 44]] }, Q: { ec: 18, groups: [[2, 17]] }, H: { ec: 22, groups: [[2, 13]] } },
  4: { L: { ec: 20, groups: [[1, 80]] }, M: { ec: 18, groups: [[2, 32]] }, Q: { ec: 26, groups: [[2, 24]] }, H: { ec: 16, groups: [[4, 9]] } },
  5: { L: { ec: 26, groups: [[1, 108]] }, M: { ec: 24, groups: [[2, 43]] }, Q: { ec: 18, groups: [[2, 15], [2, 16]] }, H: { ec: 22, groups: [[2, 11], [2, 12]] } },
  6: { L: { ec: 18, groups: [[2, 68]] }, M: { ec: 16, groups: [[4, 27]] }, Q: { ec: 24, groups: [[4, 19]] }, H: { ec: 28, groups: [[4, 15]] } },
  7: { L: { ec: 20, groups: [[2, 78]] }, M: { ec: 18, groups: [[4, 31]] }, Q: { ec: 18, groups: [[2, 14], [4, 15]] }, H: { ec: 26, groups: [[4, 13], [1, 14]] } },
  8: { L: { ec: 24, groups: [[2, 97]] }, M: { ec: 22, groups: [[2, 38], [2, 39]] }, Q: { ec: 22, groups: [[4, 18], [2, 19]] }, H: { ec: 26, groups: [[4, 14], [2, 15]] } },
  9: { L: { ec: 30, groups: [[2, 116]] }, M: { ec: 22, groups: [[3, 36], [2, 37]] }, Q: { ec: 20, groups: [[4, 16], [4, 17]] }, H: { ec: 24, groups: [[4, 12], [4, 13]] } },
  10: { L: { ec: 18, groups: [[2, 68], [2, 69]] }, M: { ec: 26, groups: [[4, 43], [1, 44]] }, Q: { ec: 24, groups: [[6, 19], [2, 20]] }, H: { ec: 28, groups: [[6, 15], [2, 16]] } },
};

// Alignment pattern centre coordinates, versions 2-10.
const ALIGN = {
  1: [],
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const MAX_VERSION = 10;

function dataCapacityBytes(version, level) {
  const spec = BLOCKS[version][level];
  return spec.groups.reduce((sum, [count, words]) => sum + count * words, 0);
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

// ---- Bit buffer -------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

// ---- Matrix construction ----------------------------------------------------

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (row, col, value) => {
    modules[row][col] = value;
    reserved[row][col] = true;
  };

  // Finder patterns plus separators.
  const finderCentres = [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ];
  for (const [cr, cc] of finderCentres) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const row = cr + dr;
        const col = cc + dc;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        // Chebyshev distance from the 7x7 centre: 0-1 dark core, 2 light ring,
        // 3 dark ring, 4 light separator.
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        setFunction(row, col, dist <= 1 || dist === 3 ? 1 : 0);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const value = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) setFunction(6, i, value);
    if (!reserved[i][6]) setFunction(i, 6, value);
  }

  // Alignment patterns.
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunction(r + dr, c + dc, dist === 0 || dist === 2 ? 1 : 0);
        }
      }
    }
  }

  // Reserve format information areas.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { modules[8][i] = 0; reserved[8][i] = true; }
    if (!reserved[i][8]) { modules[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { modules[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (!reserved[size - 1 - i][8]) { modules[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }
  setFunction(size - 8, 8, 1); // dark module

  // Reserve version information areas (versions 7+).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      if (!reserved[row][col]) { modules[row][col] = 0; reserved[row][col] = true; }
      if (!reserved[col][row]) { modules[col][row] = 0; reserved[col][row] = true; }
    }
  }

  return { size, modules, reserved };
}

function placeData(matrix, reserved, bits) {
  const { size, modules } = matrix;
  let index = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        modules[row][c] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(modules, reserved, maskIndex) {
  const size = modules.length;
  const out = modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (MASKS[maskIndex](r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function bchFormat(data) {
  let value = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((value >>> i) & 1) value ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function writeFormatInfo(modules, level, maskIndex) {
  const size = modules.length;
  const bits = bchFormat((EC_BITS[level] << 3) | maskIndex);
  const f = (i) => (bits >>> i) & 1; // f(0) is the least-significant format bit

  // First copy, wrapping the top-left finder pattern (row 6 / column 6 are the
  // timing patterns and are skipped).
  modules[8][0] = f(0);
  modules[8][1] = f(1);
  modules[8][2] = f(2);
  modules[8][3] = f(3);
  modules[8][4] = f(4);
  modules[8][5] = f(5);
  modules[8][7] = f(6);
  modules[8][8] = f(7);
  modules[7][8] = f(8);
  modules[5][8] = f(9);
  modules[4][8] = f(10);
  modules[3][8] = f(11);
  modules[2][8] = f(12);
  modules[1][8] = f(13);
  modules[0][8] = f(14);

  // Second copy: below the top-left finder and left of the bottom-left finder.
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = f(i);
  for (let i = 7; i < 15; i++) modules[8][size - 15 + i] = f(i);

  // Fixed dark module.
  modules[size - 8][8] = 1;
}

function bchVersion(version) {
  let value = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((value >>> i) & 1) value ^= 0b1111100100101 << (i - 12);
  }
  return (version << 12) | value;
}

function writeVersionInfo(modules, version) {
  if (version < 7) return;
  const size = modules.length;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    modules[row][col] = bit;
    modules[col][row] = bit;
  }
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules.
  for (let r = 0; r < size; r++) {
    for (const line of [modules[r], modules.map((row) => row[r])]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of a single colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, start, pattern) => pattern.every((p, k) => line[start + k] === p);
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    const col = modules.map((line) => line[r]);
    for (let c = 0; c + 11 <= size; c++) {
      if (matches(row, c, P1) || matches(row, c, P2)) score += 40;
      if (matches(col, c, P1) || matches(col, c, P2)) score += 40;
    }
  }

  // Rule 4: deviation from a 50% dark ratio.
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ---- Public API -------------------------------------------------------------

/**
 * Encode `text` as a QR module matrix.
 * @returns {{size:number, modules:number[][], version:number, level:string}}
 */
function encode(text, level = "M") {
  const data = Buffer.from(text, "utf8");
  // Note: level M maps to the format bits 0b00, so test membership explicitly
  // rather than relying on truthiness.
  if (!Object.prototype.hasOwnProperty.call(EC_BITS, level)) {
    throw new Error(`unsupported EC level: ${level}`);
  }

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + charCountBits(v);
    const needed = Math.ceil((headerBits + data.length * 8) / 8);
    if (needed <= dataCapacityBytes(v, level)) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(
      `payload of ${data.length} bytes exceeds the supported QR capacity (version ${MAX_VERSION} level ${level}); ` +
        `shorten the login URL or render it manually`
    );
  }

  const spec = BLOCKS[version][level];
  const capacityBits = dataCapacityBytes(version, level) * 8;

  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode
  buffer.put(data.length, charCountBits(version));
  for (const byte of data) buffer.put(byte, 8);

  // Terminator, then pad to a byte boundary.
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.put(0, 1);

  // Alternating pad bytes.
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.length < capacityBits) {
    buffer.put(PAD[padIndex++ % 2], 8);
  }

  // Split into blocks and compute parity.
  const dataBytes = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < buffer.bits.length; i++) {
    if (buffer.bits[i]) dataBytes[i >> 3] |= 0x80 >> (i & 7);
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, words] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataBytes.slice(offset, offset + words);
      offset += words;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ec));
    }
  }

  // Interleave data then parity codewords.
  const stream = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of ecBlocks) stream.push(block[i]);
  }

  const bits = [];
  for (const byte of stream) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  }

  const matrix = createMatrix(version);
  placeData(matrix, matrix.reserved, bits);

  // Pick the mask with the lowest penalty.
  let best = null;
  let bestScore = Infinity;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
    const candidate = applyMask(matrix.modules, matrix.reserved, maskIndex);
    writeFormatInfo(candidate, level, maskIndex);
    writeVersionInfo(candidate, version);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { size: matrix.size, modules: best, version, level };
}

/** Render a matrix as a terminal string using half-block characters. */
function toTerminal(matrix, { quietZone = 2, invert = false } = {}) {
  const { size, modules } = matrix;
  const total = size + quietZone * 2;
  const dark = (r, c) => {
    if (r < quietZone || c < quietZone || r >= size + quietZone || c >= size + quietZone) return false;
    const value = modules[r - quietZone][c - quietZone] === 1;
    return invert ? !value : value;
  };

  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < total ? dark(r + 1, c) : false;
      // Use full blocks for contrast; spaces keep the quiet zone clean.
      if (top && bottom) line += "\u2588";
      else if (top) line += "\u2580";
      else if (bottom) line += "\u2584";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export { encode, toTerminal };
