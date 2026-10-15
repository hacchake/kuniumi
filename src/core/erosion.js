import { mulberry32 } from './noise.js';
import { resampleImage } from './heightfield.js';

// 雨粒による水食（hydraulic erosion）。雨粒を一粒ずつ斜面に流し、
// 速く流れる所で削り、緩んだ所に土砂を置く。谷筋・ガリー・扇状地ができて「本物の山」らしくなる。
// （Hans Theobald Beyer の手法を Sebastian Lague が整理したものと同じ考え方）
//
// 表示の解像度によって侵食の形が変わらないよう、常に ER×ER の格子で計算し、
// 「削った量・盛った量」だけを各解像度へ補間して足す。
const ER = 513;
const P = {
  inertia: 0.05,
  capacity: 4,
  minCapacity: 0.01,
  deposit: 0.3,
  erode: 0.3,
  evaporate: 0.01,
  gravity: 4,
  lifetime: 30,
  radius: 3,
};

let brushCache = null;

function brushes(size) {
  if (brushCache?.size === size) return brushCache;
  const r = P.radius;
  const offs = [], weights = [];
  let sum = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y);
      if (d < r) {
        offs.push([x, y]);
        weights.push(1 - d / r);
        sum += 1 - d / r;
      }
    }
  }
  brushCache = { size, offs, weights: weights.map((w) => w / sum) };
  return brushCache;
}

// map: Float32Array(size*size)、その場で書き換える
function erode(map, size, droplets, seed) {
  const rand = mulberry32(seed);
  const { offs, weights } = brushes(size);
  const hg = (x, y) => {
    const ix = x | 0, iy = y | 0;
    const fx = x - ix, fy = y - iy;
    const i = iy * size + ix;
    const nw = map[i], ne = map[i + 1], sw = map[i + size], se = map[i + size + 1];
    return {
      h: nw * (1 - fx) * (1 - fy) + ne * fx * (1 - fy) + sw * (1 - fx) * fy + se * fx * fy,
      gx: (ne - nw) * (1 - fy) + (se - sw) * fy,
      gy: (sw - nw) * (1 - fx) + (se - ne) * fx,
    };
  };
  for (let n = 0; n < droplets; n++) {
    let x = rand() * (size - 1), y = rand() * (size - 1);
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
    for (let life = 0; life < P.lifetime; life++) {
      const nx = x | 0, ny = y | 0;
      const ox = x - nx, oy = y - ny;
      const idx = ny * size + nx;
      const a = hg(x, y);
      dx = dx * P.inertia - a.gx * (1 - P.inertia);
      dy = dy * P.inertia - a.gy * (1 - P.inertia);
      const len = Math.hypot(dx, dy);
      if (len === 0) break;
      dx /= len;
      dy /= len;
      x += dx;
      y += dy;
      if (x < 0 || x >= size - 1 || y < 0 || y >= size - 1) break;
      const dh = hg(x, y).h - a.h;
      const cap = Math.max(-dh * speed * water * P.capacity, P.minCapacity);
      if (sediment > cap || dh > 0) {
        const put = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * P.deposit;
        sediment -= put;
        map[idx] += put * (1 - ox) * (1 - oy);
        map[idx + 1] += put * ox * (1 - oy);
        map[idx + size] += put * (1 - ox) * oy;
        map[idx + size + 1] += put * ox * oy;
      } else {
        const take = Math.min((cap - sediment) * P.erode, -dh);
        for (let k = 0; k < offs.length; k++) {
          const bx = nx + offs[k][0], by = ny + offs[k][1];
          if (bx < 0 || by < 0 || bx >= size || by >= size) continue;
          const j = by * size + bx;
          const w = take * weights[k];
          const d = map[j] < w ? map[j] : w;
          map[j] -= d;
          sediment += d;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * P.gravity));
      water *= 1 - P.evaporate;
    }
  }
}

// field（res×res, 0..1）に侵食を加える。amount: 0..1
// 戻り値: { field: 侵食後, wear: 盛った量(+)・削った量(−)。地表の色づけに使う }
export function applyErosion(field, res, amount, seed) {
  if (!(amount > 0)) return { field, wear: null };
  const base = res === ER ? field.slice() : resampleImage(field, res, res, ER);
  const eroded = base.slice();
  erode(eroded, ER, Math.round(amount * 1.5 * ER * ER), seed + 999);
  const diff = new Float32Array(ER * ER);
  for (let k = 0; k < diff.length; k++) diff[k] = eroded[k] - base[k];
  const d = res === ER ? diff : resampleImage(diff, ER, ER, res);
  const out = new Float32Array(res * res);
  for (let k = 0; k < out.length; k++) out[k] = Math.min(1, Math.max(0, field[k] + d[k]));
  return { field: out, wear: d };
}
