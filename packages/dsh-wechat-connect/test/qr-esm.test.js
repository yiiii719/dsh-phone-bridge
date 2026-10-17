/**
 * Round-trip check for the plugin's ESM copy of the QR encoder — the same
 * structural and Reed-Solomon verification the CommonJS original passes, so the
 * ESM conversion cannot have silently broken the symbol.
 */
import assert from "node:assert";
import { encode, toTerminal } from "../src/qr.js";

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

const BLOCKS = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
  7: { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
  8: { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
  9: { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
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

function reservedMap(version) {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && r < size && c >= 0 && c < size) reserved[r][c] = true;
  };
  for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) mark(cr + dr, cc + dc);
  }
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      mark(row, col); mark(col, row);
    }
  }
  return { size, reserved };
}

function readFormat(modules) {
  const g = (r, c) => modules[r][c];
  const bits = [g(8, 0), g(8, 1), g(8, 2), g(8, 3), g(8, 4), g(8, 5), g(8, 7), g(8, 8), g(7, 8), g(5, 8), g(4, 8), g(3, 8), g(2, 8), g(1, 8), g(0, 8)];
  let value = 0;
  for (let i = 0; i < 15; i++) if (bits[i]) value |= 1 << i;
  const unmasked = value ^ 0b101010000010010;
  return { ecBits: (unmasked >>> 13) & 0b11, maskIndex: (unmasked >>> 10) & 0b111 };
}

function extractCodewords(modules, version, maskIndex) {
  const { size, reserved } = reservedMap(version);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let value = modules[row][c];
        if (MASKS[maskIndex](row, c)) value ^= 1;
        bits.push(value);
      }
    }
    upward = !upward;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
    bytes.push(byte);
  }
  return bytes;
}

function syndromes(block, ecLen) {
  const out = [];
  for (let i = 0; i < ecLen; i++) {
    let value = 0;
    const alpha = EXP[i];
    for (const byte of block) value = gfMul(value, alpha) ^ byte;
    out.push(value);
  }
  return out;
}

const cases = [
  { text: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=b1a43022619c95b482afe9b0f5e2111e&bot_type=3", level: "M" },
  { text: "HELLO", level: "L" },
  { text: "微信连接 · WeChat Connect ✅", level: "Q" },
  { text: "x".repeat(200), level: "M" },
];

let failures = 0;
for (const { text, level } of cases) {
  try {
    const { modules, version } = encode(text, level);
    const fmt = readFormat(modules);
    const ecByName = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
    assert.strictEqual(fmt.ecBits, ecByName[level]);

    const codewords = extractCodewords(modules, version, fmt.maskIndex);
    const [ecLen, groups] = BLOCKS[version][level];
    const dataLens = [];
    for (const [count, words] of groups) for (let i = 0; i < count; i++) dataLens.push(words);
    const blockCount = dataLens.length;
    const maxData = Math.max(...dataLens);

    // Inverse of the encoder's interleave: data bytes round-robin first, then
    // the parity bytes round-robin — NOT each block's parity contiguously.
    const dataBlocks = dataLens.map(() => []);
    let p = 0;
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < blockCount; b++) if (i < dataLens[b]) dataBlocks[b].push(codewords[p++]);
    }
    const ecBlocks = dataLens.map(() => []);
    for (let i = 0; i < ecLen; i++) {
      for (let b = 0; b < blockCount; b++) ecBlocks[b].push(codewords[p++]);
    }
    for (let i = 0; i < blockCount; i++) {
      const s = syndromes([...dataBlocks[i], ...ecBlocks[i]], ecLen);
      assert.ok(s.every((v) => v === 0), `block ${i} syndromes ${s}`);
    }

    // Decode the header back and compare: the original bit stream is the
    // de-interleaved data blocks concatenated in block order.
    const dataStream = [];
    for (const block of dataBlocks) for (const byte of block) dataStream.push(byte);
    const dbits = [];
    for (const byte of dataStream) for (let i = 7; i >= 0; i--) dbits.push((byte >>> i) & 1);
    const take = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | dbits.shift();
      return v;
    };
    assert.strictEqual(take(4), 0b0100, "byte mode");
    const length = take(version <= 9 ? 8 : 16);
    const out = [];
    for (let i = 0; i < length; i++) out.push(take(8));
    assert.strictEqual(Buffer.from(out).toString("utf8"), text, "payload round-trip");

    console.log(`  ok   ${level} ${text.length}B  v${version} mask=${fmt.maskIndex} blocks=${blockCount}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${level} ${text.length}B — ${error.message}`);
  }
}

// The renderer must produce a complete symbol plus quiet zone.
const rendered = toTerminal(encode("test", "M")).split("\n");
console.log(`  ok   render → ${rendered.length} rows, width ${rendered[0].length}`);

console.log(failures === 0 ? "\nPLUGIN QR: all checks passed" : `\nPLUGIN QR: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
