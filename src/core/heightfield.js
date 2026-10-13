import { createSimplex2D } from './noise.js';

// 高さ場は「res×res の Float32Array、値は 0..1 に正規化」で統一する。
// 並びは field[j * res + i]、i が西(-X)→東(+X)、j が北(-Z)→南(+Z)。
// 実際の標高は baseHeight + 値 × heightScale。ハイトマップ画像も同じ向き（画像の上 = 北）。

export function generateNoiseField(params, res) {
  const { seed, frequency, octaves, persistence, lacunarity, ridged, warp, valley, falloff } = params;
  const base = createSimplex2D(seed);
  const warpX = createSimplex2D(seed + 101);
  const warpY = createSimplex2D(seed + 202);
  const field = new Float32Array(res * res);
  const oct = Math.max(1, Math.round(octaves));

  // 格子で表せないほど細かいオクターブはトゲや縞（エイリアシング）になるので、解像度に応じて弱めて切る。
  // シンプレックスノイズは周波数1で約1山。格子 3 マスに 1 山より細かいものは消す
  const nyquist = (res - 1) / 3;
  const octWeight = [];
  for (let o = 0, f = frequency; o < oct; o++, f *= lacunarity) {
    const t = Math.min(1, Math.max(0, (nyquist - f) / (nyquist * 0.5)));
    octWeight.push(t * t * (3 - 2 * t));
  }
  // オクターブ重みの合計で割って -1..1 程度に収める
  let ampSum = 0;
  for (let o = 0, a = 1; o < oct; o++, a *= persistence) ampSum += a * octWeight[o];

  for (let j = 0; j < res; j++) {
    const v = j / (res - 1);
    for (let i = 0; i < res; i++) {
      const u = i / (res - 1);
      let x = (u - 0.5) * frequency;
      let y = (v - 0.5) * frequency;

      if (warp > 0) {
        const wx = fbm(warpX, x * 0.8, y * 0.8, 3, 0.5, 2.0);
        const wy = fbm(warpY, x * 0.8, y * 0.8, 3, 0.5, 2.0);
        x += wx * warp * 1.2;
        y += wy * warp * 1.2;
      }

      // 通常の fBm と、尾根状の ridged multifractal を混ぜる
      let smooth = 0;
      let ridge = 0;
      let amp = 1;
      let freq = 1;
      let weight = 1;
      for (let o = 0; o < oct; o++) {
        const w = octWeight[o];
        if (w === 0) break;
        const n = base(x * freq + o * 17.31, y * freq - o * 9.17);
        smooth += n * amp * w;
        // |n| の折れ目をわずかに丸め、格子上でのギザギザを防ぐ
        let r = 1 - Math.sqrt(n * n + 0.003);
        r *= r;
        r *= weight;
        weight = Math.min(1, r * 2);
        ridge += r * amp * w;
        amp *= persistence;
        freq *= lacunarity;
      }
      smooth = smooth / ampSum * 0.5 + 0.5;
      ridge = ridge / ampSum;
      let h = smooth * (1 - ridged) + ridge * ridged * 1.1;

      if (falloff > 0) {
        // 中心からの距離で外周を沈める（四角を感じさせないよう丸めた距離）
        const dx = u * 2 - 1;
        const dy = v * 2 - 1;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2 * 1.25);
        const f = d * d * (3 - 2 * d);
        h -= f * falloff * 0.9;
      }
      field[j * res + i] = h;
    }
  }

  normalize(field);
  if (valley !== 1) {
    for (let k = 0; k < field.length; k++) field[k] = Math.pow(field[k], valley);
  }
  return field;
}

function fbm(noise, x, y, oct, pers, lac) {
  let s = 0;
  let a = 1;
  let f = 1;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    s += noise(x * f, y * f) * a;
    n += a;
    a *= pers;
    f *= lac;
  }
  return s / n;
}

export function normalize(field) {
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < field.length; k++) {
    const v = field[k];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (let k = 0; k < field.length; k++) field[k] = (field[k] - min) / span;
  return { min, max };
}

// 双一次補間で別解像度へ（u,v は 0..1）
export function sampleField(field, res, u, v) {
  const x = Math.min(Math.max(u, 0), 1) * (res - 1);
  const y = Math.min(Math.max(v, 0), 1) * (res - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, res - 1);
  const y1 = Math.min(y0 + 1, res - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = field[y0 * res + x0];
  const b = field[y0 * res + x1];
  const c = field[y1 * res + x0];
  const d = field[y1 * res + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// 長方形の画像から正方形の高さ場へ（足りない向きは引き伸ばす）
export function resampleImage(data, width, height, res) {
  const out = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const fy = (j / (res - 1)) * (height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, height - 1);
    const ty = fy - y0;
    for (let i = 0; i < res; i++) {
      const fx = (i / (res - 1)) * (width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, width - 1);
      const tx = fx - x0;
      const a = data[y0 * width + x0];
      const b = data[y0 * width + x1];
      const c = data[y1 * width + x0];
      const d = data[y1 * width + x1];
      out[j * res + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

export function fieldRange(field) {
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < field.length; k++) {
    if (field[k] < min) min = field[k];
    if (field[k] > max) max = field[k];
  }
  return { min, max };
}
