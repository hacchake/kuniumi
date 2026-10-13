import { hash2 } from './noise.js';

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

export function computeTerrainColors(field, res, opts) {
  const { size, heightScale, baseHeight, waterLevel, waterEnabled, palette, seed = 0 } = opts;
  const tex = textureSizeFor(res);
  const out = new Uint8ClampedArray(tex * tex * 4);

  const P = {
    shore: lin(palette.shore),
    low: lin(palette.low),
    high: lin(palette.high),
    rock: lin(palette.rock),
    snow: lin(palette.snow),
  };
  const sea = waterEnabled ? waterLevel : baseHeight - 1;
  const top = baseHeight + heightScale;
  const cell = size / (res - 1);
  const shoreBand = Math.max(4, heightScale * 0.012);

  const col = [0, 0, 0];
  const mix = (c, t) => {
    col[0] += (c[0] - col[0]) * t;
    col[1] += (c[1] - col[1]) * t;
    col[2] += (c[2] - col[2]) * t;
  };

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
      const H = baseHeight + h01 * heightScale;
      // 格子セル内の勾配（双一次面の偏微分）
      const dhx = ((b - a) * (1 - fy) + (d - c) * fy) * heightScale / cell;
      const dhz = ((c - a) * (1 - fx) + (d - b) * fx) * heightScale / cell;
      const slope = Math.sqrt(dhx * dhx + dhz * dhz);

      // 色のゆらぎ（2段の格子ノイズ）
      const n1 = valueNoise(tx / 24, ty / 24, seed) - 0.5;
      const n2 = valueNoise(tx / 5, ty / 5, seed + 7) - 0.5;
      const jitter = n1 * 0.75 + n2 * 0.25;

      const alt = (H - sea) / Math.max(1, top - sea); // 水面=0, 最高点=1
      // 低地 → 高地
      col[0] = P.low[0];
      col[1] = P.low[1];
      col[2] = P.low[2];
      mix(P.high, smooth(0.3, 0.75, alt + jitter * 0.12));
      // 岩肌
      const rs = palette.rockSlope;
      mix(P.rock, smooth(rs * 0.7, rs * 1.25, slope + jitter * 0.15));
      // 雪（急斜面には積もりにくい）
      const sl = palette.snowLine;
      const snow = smooth(sl - 0.04, sl + 0.06, alt + jitter * 0.08) * (1 - smooth(rs * 1.1, rs * 1.9, slope));
      mix(P.snow, snow);
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
      const o = (ty * tex + tx) * 4;
      out[o] = toSrgb(Math.min(1, col[0] * lum)) * 255;
      out[o + 1] = toSrgb(Math.min(1, col[1] * lum)) * 255;
      out[o + 2] = toSrgb(Math.min(1, col[2] * lum)) * 255;
      out[o + 3] = 255;
    }
  }
  return { data: out, size: tex };
}
