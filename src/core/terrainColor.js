import { hash2 } from './noise.js';
import { createVegetationRules, shoreBandOf } from './vegetation.js';

// 高さ場から地表の色テクスチャ（RGBA, 行0 = 北）を作る。
// リアルタイム表示と glTF 書き出しで同じ絵を使うため、シェーダではなく CPU で焼く。

export function textureSizeFor(res) {
  return Math.min(2048, (res - 1) * 4);
}

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// sRGB の値を線形で混ぜると暗く濁るので、線形化して混ぜてから戻す
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const lin = (hex) => hexToRgb(hex).map(toLin);

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 格子ハッシュを滑らかに補間した値ノイズ（0..1）
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// 1 点の地表の色（線形 RGB）を決める関数を作る。テクスチャを焼くときも、静止画の近景で頂点ごとに塗るときも同じ規則。
// shade(H: 標高 m, slope: 勾配 tan, wv: 侵食で盛った(+)/削った(−)量, jitter: −0.5..0.5 のゆらぎ, out: [r,g,b])
export function createTerrainShader(opts) {
  const { heightScale, baseHeight, waterLevel, waterEnabled, palette } = opts;
  const P = {
    shore: lin(palette.shore),
    low: lin(palette.low),
    high: lin(palette.high),
    rock: lin(palette.rock),
    snow: lin(palette.snow),
  };
  // 土砂の色：水辺と高地の中間
  P.soil = P.shore.map((v, i) => (v + P.high[i]) * 0.5);
  const sea = waterEnabled ? waterLevel : baseHeight - 1;
  const top = baseHeight + heightScale;
  const shoreBand = shoreBandOf(heightScale, baseHeight, sea);
  const rs = palette.rockSlope;
  const sl = palette.snowLine;
  const rockCol = [0, 0, 0];
  const rules = createVegetationRules(opts);
  P.forest = lin(palette.forest ?? '#1f3018');

  // x, z（世界座標）を渡すと、森の所を森の色にする
  return function shade(H, slope, wv, jitter, col, x, z) {
    const mix = (c, t) => {
      col[0] += (c[0] - col[0]) * t;
      col[1] += (c[1] - col[1]) * t;
      col[2] += (c[2] - col[2]) * t;
    };
    const alt = (H - sea) / Math.max(1, top - sea); // 水面=0, 最高点=1
    // 低地 → 高地
    col[0] = P.low[0];
    col[1] = P.low[1];
    col[2] = P.low[2];
    mix(P.high, smooth(0.3, 0.75, alt + jitter * 0.12));
    const veg = 1 + jitter * 0.5;
    col[0] *= veg * (1 + jitter * 0.25);
    col[1] *= veg;
    col[2] *= veg * (1 - jitter * 0.2);
    // 侵食の跡：土砂のたまった所は土の色（植物が薄い）、強く削られた谷筋は岩肌
    if (wv) {
      mix(P.soil, smooth(0.002, 0.02, wv) * 0.7);
      mix(P.rock, smooth(0.004, 0.04, -wv) * 0.45);
    }
    // 森：木の密度ぶん、遠くから見た森の色（暗い緑）へ
    if (x !== undefined) mix(P.forest, rules.forest(H, slope, wv, x, z) * 0.85);
    // 岩肌：明るさにむらと地層の縞を付ける（一様な灰色だと作り物に見える）
    const strata = Math.sin((H / Math.max(8, heightScale * 0.03) + jitter * 2.5) * Math.PI * 2) * 0.16;
    const tone = Math.max(0.35, 1 + jitter * 0.9 + strata);
    rockCol[0] = P.rock[0] * tone * (1 + strata * 0.4);
    rockCol[1] = P.rock[1] * tone;
    rockCol[2] = P.rock[2] * tone * (1 - strata * 0.3);
    mix(rockCol, smooth(rs * 0.7, rs * 1.25, slope + jitter * 0.15));
    // 雪（急斜面には積もりにくい）
    mix(P.snow, smooth(sl - 0.04, sl + 0.06, alt + jitter * 0.08) * (1 - smooth(rs * 1.1, rs * 1.9, slope)));
    // 水際の砂浜と水中
    if (waterEnabled) {
      const above = H - sea;
      mix(P.shore, (1 - smooth(shoreBand * 0.5, shoreBand * 1.6, above + jitter * shoreBand)) * (1 - smooth(0.4, 0.9, slope)));
      if (above < 0) {
        const deep = smooth(0, shoreBand * 6, -above);
        col[0] *= 1 - deep * 0.55;
        col[1] *= 1 - deep * 0.45;
        col[2] *= 1 - deep * 0.35;
      }
    }
    // ゆらぎで明るさにも少しムラ
    const lum = 1 + jitter * 0.18;
    col[0] = Math.min(1, col[0] * lum);
    col[1] = Math.min(1, col[1] * lum);
    col[2] = Math.min(1, col[2] * lum);
    return col;
  };
}

export { valueNoise };

// wear: 侵食で盛った(+)・削った(−)量（null なら侵食なし）
export function computeTerrainColors(field, res, opts, wear = null) {
  const { size, heightScale, baseHeight, seed = 0 } = opts;
  const tex = opts.textureSize ?? textureSizeFor(res);
  const out = new Uint8ClampedArray(tex * tex * 4);
  const shade = createTerrainShader(opts);
  const cell = size / (res - 1);
  const col = [0, 0, 0];

  for (let ty = 0; ty < tex; ty++) {
    const gy = (ty / (tex - 1)) * (res - 1);
    const y0 = Math.min(Math.floor(gy), res - 2);
    const fy = gy - y0;
    for (let tx = 0; tx < tex; tx++) {
      const gx = (tx / (tex - 1)) * (res - 1);
      const x0 = Math.min(Math.floor(gx), res - 2);
      const fx = gx - x0;
      const k = y0 * res + x0;
      const a = field[k];
      const b = field[k + 1];
      const c = field[k + res];
      const d = field[k + res + 1];
      const h01 = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      // 格子セル内の勾配（双一次面の偏微分）
      const dhx = ((b - a) * (1 - fy) + (d - c) * fy) * heightScale / cell;
      const dhz = ((c - a) * (1 - fx) + (d - b) * fx) * heightScale / cell;
      const wv = wear ? (wear[k] * (1 - fx) + wear[k + 1] * fx) * (1 - fy) + (wear[k + res] * (1 - fx) + wear[k + res + 1] * fx) * fy : 0;
      // 色のゆらぎ（2段の格子ノイズ）
      const jitter = (valueNoise(tx / 24, ty / 24, seed) - 0.5) * 0.75 + (valueNoise(tx / 5, ty / 5, seed + 7) - 0.5) * 0.25;
      const wx = (tx / (tex - 1) - 0.5) * size, wz = (ty / (tex - 1) - 0.5) * size;
      shade(baseHeight + h01 * heightScale, Math.sqrt(dhx * dhx + dhz * dhz), wv, jitter, col, wx, wz);
      const o = (ty * tex + tx) * 4;
      out[o] = toSrgb(col[0]) * 255;
      out[o + 1] = toSrgb(col[1]) * 255;
      out[o + 2] = toSrgb(col[2]) * 255;
      out[o + 3] = 255;
    }
  }
  return { data: out, size: tex };
}
