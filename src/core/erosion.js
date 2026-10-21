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

// map: Float32Array(size*size)、その場で書き換える。q: 雨粒の性質（P を上書きしたもの）
function erode(map, size, droplets, seed, q = P) {
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
      dx = dx * q.inertia - a.gx * (1 - q.inertia);
      dy = dy * q.inertia - a.gy * (1 - q.inertia);
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
        const put = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * q.deposit;
        sediment -= put;
        map[idx] += put * (1 - ox) * (1 - oy);
        map[idx + 1] += put * ox * (1 - oy);
        map[idx + size] += put * (1 - ox) * oy;
        map[idx + size + 1] += put * ox * oy;
      } else {
        const take = Math.min((cap - sediment) * q.erode, -dh);
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

// 盛った分（正の値）だけを 3×3 の平均で passes 回ならす。削った分（負の値）はそのまま
function smoothDeposits(d, n, passes) {
  let pos = new Float32Array(d.length);
  for (let k = 0; k < d.length; k++) pos[k] = d[k] > 0 ? d[k] : 0;
  let tmp = new Float32Array(d.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= n) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= n) continue;
            s += pos[jj * n + ii];
            c++;
          }
        }
        tmp[j * n + i] = s / c;
      }
    [pos, tmp] = [tmp, pos];
  }
  for (let k = 0; k < d.length; k++) d[k] = Math.min(d[k], 0) + pos[k];
}

// ノイズ設定から雨粒の性質を作る（未設定なら既定の性質）
//   erosionInertia: 流れのまっすぐさ（大きいほど谷が蛇行せず長くまっすぐに）
//   erosionDeposit: 土砂の置きやすさ（大きいほど谷底や裾に扇状地が厚く積もる）
//   erosionStrength: 削る強さ（大きいほど谷が深く鋭く刻まれる）
export function erosionParams(noise = {}) {
  return {
    ...P,
    inertia: noise.erosionInertia ?? P.inertia,
    deposit: noise.erosionDeposit ?? P.deposit,
    erode: noise.erosionStrength ?? P.erode,
  };
}

// field（res×res, 0..1）に侵食を加える。amount: 0..1。q: 雨粒の性質（erosionParams）
// 戻り値: { field: 侵食後, wear: 盛った量(+)・削った量(−)。地表の色づけに使う }
export function applyErosion(field, res, amount, seed, q = P) {
  if (!(amount > 0)) return { field, wear: null };
  const base = res === ER ? field.slice() : resampleImage(field, res, res, ER);
  const eroded = base.slice();
  erode(eroded, ER, Math.round(amount * 1.5 * ER * ER), seed + 999, q);
  const diff = new Float32Array(ER * ER);
  for (let k = 0; k < diff.length; k++) diff[k] = eroded[k] - base[k];
  // 土砂のたまり（+）は、雨粒が少しずつ置くので格子 1〜2 マスの波紋（段）になる。そのままでは平地や斜面の裾が
  // 等高線のような縞・段々畑に見えるので、たまった分だけをならす（削った谷筋（−）は鋭いまま）
  smoothDeposits(diff, ER, 2);
  const d = res === ER ? diff : resampleImage(diff, ER, ER, res);
  const out = new Float32Array(res * res);
  for (let k = 0; k < out.length; k++) out[k] = Math.min(1, Math.max(0, field[k] + d[k]));
  return { field: out, wear: d };
}
