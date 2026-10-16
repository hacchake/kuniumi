import { hash2 } from './noise.js';

// 格子（高さ場の画素）より細かい所に足す小さな起伏。リアルタイム表示（GPU）と一枚絵（CPU）で同じ式。
// 波長は 2 の累乗にそろえてある：GPU 側は「65536 m ごとの原点」からの相対座標で計算するので、
// 波長が原点の間隔を割り切れれば、何千 km 離れた所でも格子が正確に一致する。

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 勾配ノイズ（−0.7..0.7 くらい）。格子点の向きは hash2 から
export function gradNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const g = (i, j, dx, dz) => {
    const a = hash2(xi + i, zi + j, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dz;
  };
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = g(0, 0, fx, fz), b = g(1, 0, fx - 1, fz);
  const c = g(0, 1, fx, fz - 1), d = g(1, 1, fx - 1, fz - 1);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

export const DETAIL_SEED = 9173;
export const DETAIL_OCTAVES = 12;

// 一番長い波長：格子の間隔より少し長い 2 の累乗
export function detailBaseWavelength(cell) {
  return 2 ** Math.ceil(Math.log2(Math.max(0.5, cell * 1.2)));
}

// cell: 高さ場の格子の間隔 (m)、spacing: これより細かい起伏は足さない (m)、amount: 強さ（0 = なし）
// 海面の近くでは細部の起伏を弱める（海岸線は元の地形で決める）。
// 海面すれすれの平野で、細かい凹凸が水面の上下をまたいで水たまりの縞・ちらつきになるのを防ぐ。
// h: 細部を足す前の標高、sea: 水面の高さ（水が無ければ null）
export const SHORE_FADE = 4; // m
export function shoreFade(h, sea) {
  if (sea == null) return 1;
  return Math.min(1, Math.abs(h - sea) / SHORE_FADE);
}

export function detailHeight(x, z, cell, spacing, amount) {
  if (!(amount > 0)) return 0;
  let lambda = detailBaseWavelength(cell);
  let s = 0;
  for (let o = 0; o < DETAIL_OCTAVES; o++) {
    const w = smooth(spacing * 2, spacing * 4, lambda);
    if (w <= 0 || lambda < 0.25) break;
    s += gradNoise(x / lambda, z / lambda, DETAIL_SEED + o) * lambda * 0.03 * w;
    lambda *= 0.5;
  }
  return s * amount;
}
