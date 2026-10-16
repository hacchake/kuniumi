// 地球モードの標高タイルを取り寄せて、描くための形にする（メインスレッドを止めない）。
//   grid: 区画の頂点の標高（33 × 33、m）
//   tex : 256 × 256 の RGBA 半精度（R, G = 東・北への傾き、B = 標高 m、A = 1）
import { TERRARIUM_URL, TILE, repairElevation } from '../core/geo.js';
import { decodePng } from '../core/png16.js';
import { GLOBE_R, mercYToLat, sampleGrid } from '../core/globe.js';

const MAX_PARALLEL = 8;
let running = 0;
const queue = [];

self.onmessage = (e) => {
  const m = e.data;
  if (m.cancel) {
    // まだ取りに行っていない注文は取り消す（見えなくなった所）
    const keep = new Set(m.keep);
    for (let k = queue.length - 1; k >= 0; k--) {
      if (!keep.has(queue[k].key)) {
        self.postMessage({ key: queue[k].key, cancelled: true });
        queue.splice(k, 1);
      }
    }
    return;
  }
  queue.push(m);
  pump();
};

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    // 粗いズーム（広い所）から先に
    let best = 0;
    for (let k = 1; k < queue.length; k++) if (queue[k].z < queue[best].z) best = k;
    const job = queue.splice(best, 1)[0];
    running++;
    load(job)
      .then((r) => self.postMessage(r, [r.grid.buffer, r.tex.buffer]))
      .catch((err) => self.postMessage({ key: job.key, error: String(err?.message ?? err) }))
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function load({ key, z, x, y }) {
  const heights = await fetchTile(z, x, y);
  const n = 2 ** z;
  const tex = new Uint16Array(TILE * TILE * 4);
  let min = Infinity, max = -Infinity;
  const one = toHalf(1);
  for (let j = 0; j < TILE; j++) {
    // 画素の大きさ（m）。メルカトルは正角なので東西と南北で同じ
    const lat = mercYToLat((y + (j + 0.5) / TILE) / n);
    const px = (2 * Math.PI * GLOBE_R * Math.cos((lat * Math.PI) / 180)) / (TILE * n);
    const jn = Math.max(0, j - 1), js = Math.min(TILE - 1, j + 1);
    for (let i = 0; i < TILE; i++) {
      const h = heights[j * TILE + i];
      if (h < min) min = h;
      if (h > max) max = h;
      const iw = Math.max(0, i - 1), ie = Math.min(TILE - 1, i + 1);
      // 海の中は海面（平ら）として傾きを 0 に
      const sh = (v) => Math.max(0, v);
      const ge = (sh(heights[j * TILE + ie]) - sh(heights[j * TILE + iw])) / ((ie - iw) * px);
      const gn = (sh(heights[jn * TILE + i]) - sh(heights[js * TILE + i])) / ((js - jn) * px);
      const k = (j * TILE + i) * 4;
      tex[k] = toHalf(ge);
      tex[k + 1] = toHalf(gn);
      tex[k + 2] = toHalf(h);
      tex[k + 3] = one;
    }
  }
  return { key, grid: sampleGrid(heights, TILE), tex, min, max };
}

async function fetchTile(z, x, y) {
  const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return new Float32Array(TILE * TILE); // 無い所は 0 m
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      const img = await decodePng(buf, { terrarium: true });
      if (img && img.width === TILE) return repairElevation(img.data, TILE);
      throw new Error('PNG');
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
  }
}

// 32bit 浮動小数 → 16bit 半精度
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7bff; // 大きすぎる値は最大値に
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | (e << 10) | ((m + 0x1000) >> 13);
}
