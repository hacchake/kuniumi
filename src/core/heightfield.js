import { createSimplex2D } from './noise.js';

// 高さ場は「res×res の Float32Array、値は 0..1 に正規化」で統一する。
// 並びは field[j * res + i]、i が西(-X)→東(+X)、j が北(-Z)→南(+Z)。
// 実際の標高は baseHeight + 値 × heightScale。ハイトマップ画像も同じ向き（画像の上 = 北）。

// ノイズ地形の「生の高さ」を任意の地点で計算する関数を作る。
// raw(u, v, nyq): u,v は 0..1、nyq は「地形の端から端までに何山まで描くか」の上限（細かさの打ち切り）。
// 打ち切りは滑らかに弱めるので、格子にしても尖りや縞が出ない。
// options.refNyquist: 振幅の正規化に使う打ち切り（同じ値なら、細かさを変えても大きな形と高さは変わらない）
// options.extraOctaves: 設定の段数を超えて足してよい細部の段数（静止画の近景用）
export function createNoiseSampler(params, { refNyquist, extraOctaves = 0 } = {}) {
  const { seed, frequency, octaves, persistence, lacunarity, ridged, warp, falloff } = params;
  const base = createSimplex2D(seed);
  const warpX = createSimplex2D(seed + 101);
  const warpY = createSimplex2D(seed + 202);
  const oct = Math.max(1, Math.round(octaves));
  const maxOct = oct + extraOctaves;
  const weightAt = (f, nyq) => {
    const t = Math.min(1, Math.max(0, (nyq - f) / (nyq * 0.5)));
    return t * t * (3 - 2 * t);
  };
  // オクターブ重みの合計で割って -1..1 程度に収める（基準の打ち切りで固定）
  let ampSum = 0;
  for (let o = 0, a = 1, f = frequency; o < oct; o++, a *= persistence, f *= lacunarity) ampSum += a * weightAt(f, refNyquist);

  return function raw(u, v, nyq) {
    let x = (u - 0.5) * frequency;
    let y = (v - 0.5) * frequency;
    if (warp > 0) {
      const wx = fbm(warpX, x * 0.8, y * 0.8, 3, 0.5, 2.0);
      const wy = fbm(warpY, x * 0.8, y * 0.8, 3, 0.5, 2.0);
      x += wx * warp * 1.2;
      y += wy * warp * 1.2;
    }
    // 通常の fBm と、尾根状の ridged multifractal を混ぜる
    let smooth = 0, ridge = 0, amp = 1, freq = 1, weight = 1;
    for (let o = 0; o < maxOct; o++) {
      const w = weightAt(frequency * freq, nyq);
      if (w === 0) break;
      const n = base(x * freq + o * 17.31, y * freq - o * 9.17);
      if (o >= oct) {
        // 設定の段数を超えて足す細部（静止画の近景）：尾根状にすると規則的な波模様になるので、
        // なだらかなノイズだけを、段ごとにさらに弱めて足す
        smooth += n * amp * w * Math.pow(0.6, o - oct + 1);
      } else {
        smooth += n * amp * w;
        // |n| の折れ目をわずかに丸め、格子上でのギザギザを防ぐ
        let r = 1 - Math.sqrt(n * n + 0.003);
        r *= r;
        r *= weight;
        weight = Math.min(1, r * 2);
        ridge += r * amp * w;
      }
      amp *= persistence;
      freq *= lacunarity;
    }
    smooth = (smooth / ampSum) * 0.5 + 0.5;
    ridge = ridge / ampSum;
    let h = smooth * (1 - ridged) + ridge * ridged * 1.1;
    if (falloff > 0) {
      // 中心からの距離で外周を沈める（四角を感じさせないよう丸めた距離）
      const dx = u * 2 - 1;
      const dy = v * 2 - 1;
      const d = Math.min(1, (Math.sqrt(dx * dx + dy * dy) / Math.SQRT2) * 1.25);
      h -= d * d * (3 - 2 * d) * falloff * 0.9;
    }
    return h;
  };
}

// 「外周の沈み」があるとき、正規化した高さに掛ける縁の減衰（四辺の際で 0）。
// 縁に山がかかったまま正方形で切れると、断崖や水越しの直線の境目になるため
export function edgeFade(u, v, falloff) {
  if (!(falloff > 0)) return 1;
  // 四辺からの距離で沈める。辺に沿って沈み始める所をゆるく波打たせる（まっすぐだと、島の海岸が
  // 定規で引いたような直線になった）。いちばん外（辺の上）では必ず底まで沈む
  const x = u * 2 - 1, y = v * 2 - 1;
  const ex = Math.abs(x) + 0.06 * (Math.sin(4.7 * y + 1.1) * 0.6 + Math.sin(11.9 * y + 2.3) * 0.4);
  const ey = Math.abs(y) + 0.06 * (Math.sin(5.3 * x + 0.7) * 0.6 + Math.sin(12.7 * x + 1.9) * 0.4);
  const e = Math.max(ex, ey);
  const t = Math.min(1, Math.max(0, (e - 0.74) / 0.2));
  return 1 - t * t * (3 - 2 * t) * Math.min(1, falloff * 2);
}

// res×res の格子で生成し、0..1 に正規化して谷の平らさ（指数）を掛ける。
// 戻り値の min/max は正規化前の範囲（静止画の近景で同じ正規化を再現するのに使う）
export function generateNoiseFieldWithRange(params, res) {
  // 格子で表せないほど細かいオクターブはトゲや縞（エイリアシング）になるので、解像度に応じて弱めて切る。
  // シンプレックスノイズは周波数1で約1山。格子 3 マスに 1 山より細かいものは消す
  const nyq = (res - 1) / 3;
  const raw = createNoiseSampler(params, { refNyquist: nyq });
  const field = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const v = j / (res - 1);
    for (let i = 0; i < res; i++) field[j * res + i] = raw(i / (res - 1), v, nyq);
  }
  const { min, max } = normalize(field);
  if (params.valley !== 1) {
    for (let k = 0; k < field.length; k++) field[k] = Math.pow(field[k], params.valley);
  }
  if (params.falloff > 0) {
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) field[j * res + i] *= edgeFade(i / (res - 1), j / (res - 1), params.falloff);
  }
  return { field, min, max };
}

export function generateNoiseField(params, res) {
  return generateNoiseFieldWithRange(params, res).field;
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
