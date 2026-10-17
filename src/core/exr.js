// OpenEXR（.exr）の書き出し：圧縮なし・走査線ごと・半精度（16bit 浮動小数）の B, G, R の 3 チャンネル。
// Blender・Nuke・Photoshop などで、ノイズ除去後の線形 HDR をそのまま扱える（.hdr より色の精度が高い）。
// hdr: Float32Array(width × height × 4)（RGBA、行 0 = 画像の上）

// float32 → half（IEEE 754 binary16）。丸めは最も近い値へ
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0); // 無限大・NaN
  if (e >= 0x1f) return sign | 0x7c00; // 大きすぎる → 無限大
  if (e <= 0) {
    if (e < -10) return sign; // 小さすぎる → 0
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  const h = sign | (e << 10) | (m >> 13);
  return h + ((m >> 12) & 1); // 繰り上がりで指数へ進んでも正しい値になる
}

export function encodeEXR(hdr, width, height) {
  const enc = new TextEncoder();
  const parts = [];
  const u8 = (n) => parts.push(new Uint8Array([n]));
  const i32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    parts.push(b);
  };
  const f32le = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    parts.push(b);
  };
  const str = (s) => parts.push(enc.encode(`${s}\0`));
  const attr = (name, type, size, write) => {
    str(name);
    str(type);
    i32(size);
    write();
  };
  // 魔法の数・版 2（走査線、単一部分）
  parts.push(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]));
  const chans = ['B', 'G', 'R']; // 名前の順に並べる決まり
  attr('channels', 'chlist', chans.length * 18 + 1, () => {
    for (const c of chans) {
      str(c);
      i32(1); // HALF
      parts.push(new Uint8Array([0, 0, 0, 0])); // pLinear と予約
      i32(1);
      i32(1);
    }
    u8(0);
  });
  attr('compression', 'compression', 1, () => u8(0)); // 圧縮なし
  const box = () => {
    i32(0);
    i32(0);
    i32(width - 1);
    i32(height - 1);
  };
  attr('dataWindow', 'box2i', 16, box);
  attr('displayWindow', 'box2i', 16, box);
  attr('lineOrder', 'lineOrder', 1, () => u8(0)); // 上の行から
  attr('pixelAspectRatio', 'float', 4, () => f32le(1));
  attr('screenWindowCenter', 'v2f', 8, () => {
    f32le(0);
    f32le(0);
  });
  attr('screenWindowWidth', 'float', 4, () => f32le(1));
  u8(0); // 見出しの終わり
  const headLen = parts.reduce((a, p) => a + p.length, 0);
  const lineBytes = width * 2 * chans.length;
  const blockLen = 8 + lineBytes;
  const out = new Uint8Array(headLen + height * 8 + height * blockLen);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  const dv = new DataView(out.buffer);
  // 各行の位置の表
  const first = headLen + height * 8;
  for (let y = 0; y < height; y++) {
    dv.setBigUint64(o, BigInt(first + y * blockLen), true);
    o += 8;
  }
  // 行ごと：行番号・長さ・B の列・G の列・R の列
  const order = [2, 1, 0];
  for (let y = 0; y < height; y++) {
    dv.setInt32(o, y, true);
    dv.setInt32(o + 4, lineBytes, true);
    o += 8;
    for (const c of order) {
      for (let x = 0; x < width; x++) {
        dv.setUint16(o, toHalf(hdr[(y * width + x) * 4 + c]), true);
        o += 2;
      }
    }
  }
  return new Blob([out], { type: 'image/x-exr' });
}
