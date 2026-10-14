import { hash2 } from './noise.js';
import { hexToRgb } from './terrainColor.js';

// 物体の表面模様（手続きテクスチャ）を作る。Three.js 非依存（ワーカーで動かす）。
// 画像は横に周期 scale×aspect、縦に周期 scale で継ぎ目なく繰り返す。
// 球や円柱は横 2 : 縦 1 の画像（aspect=2）、立方体などは正方形（aspect=1）にする。

export const PATTERNS = [
  ['solid', '単色'],
  ['planet', '大陸と海'],
  ['gas', 'ガスの縞'],
  ['lava', '溶岩'],
  ['marble', '大理石'],
  ['rock', '岩肌'],
  ['cells', '細胞'],
  ['craters', 'クレーター'],
  ['stripes', '縞'],
  ['checker', '市松'],
  ['image', '画像'],
];

// 周期 px×py で一周する値ノイズ（0..1）
function pnoise(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const wx0 = ((xi % px) + px) % px, wx1 = (wx0 + 1) % px;
  const wy0 = ((yi % py) + py) % py, wy1 = (wy0 + 1) % py;
  const a = hash2(wx0, wy0, seed), b = hash2(wx1, wy0, seed);
  const c = hash2(wx0, wy1, seed), d = hash2(wx1, wy1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// 周期つき fBm（0..1）。u,v は 0..1、px,py は最も粗い段の周期
function pfbm(u, v, px, py, seed, oct = 5) {
  let s = 0, a = 1, n = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += pnoise(u * px * f, v * py * f, px * f, py * f, seed + o * 31) * a;
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

// 周期つきのボロノイ（F1, F2 距離）
function pworley(u, v, px, py, seed) {
  const x = u * px, y = v * py;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % px) + px) % px, wy = ((cy % py) + py) % py;
      const fx = cx + hash2(wx, wy, seed) - x;
      const fy = cy + hash2(wx, wy, seed + 17) - y;
      const d = Math.sqrt(fx * fx + fy * fy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2];
}

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 模様ごとに (u,v) → { t: 色の混ぜ具合 0..1, h: 凹凸 0..1, g: 発光の強さ 0..1 }
function patternFn(p, aspect) {
  const S = Math.max(1, Math.round(p.scale));
  const PX = Math.max(1, Math.round(S * aspect));
  const PY = S;
  const seed = p.seed | 0;
  switch (p.pattern) {
    case 'planet':
      return (u, v) => {
        const n = pfbm(u, v, PX, PY, seed, 6);
        const land = sm(0.48, 0.53, n);
        const lat = Math.abs(v - 0.5) * 2; // 極ほど白く
        const ice = sm(0.82, 0.92, lat + (n - 0.5) * 0.3);
        return { t: land, h: land * (n - 0.48) * 4, g: 0, ice };
      };
    case 'gas':
      return (u, v) => {
        const n = pfbm(u, v, PX, PY, seed, 4);
        const b = 0.5 + 0.5 * Math.sin((v * PY * 3 + (n - 0.5) * 2.2) * Math.PI * 2);
        return { t: b, h: 0, g: 0 };
      };
    case 'lava':
      return (u, v) => {
        const [f1, f2] = pworley(u, v, PX * 2, PY * 2, seed);
        const n = pfbm(u, v, PX, PY, seed + 5, 5);
        const crack = 1 - sm(0.02, 0.12 + n * 0.1, f2 - f1);
        const glow = crack * sm(0.35, 0.7, n + 0.2);
        return { t: glow, h: 1 - crack * 0.8 - (1 - n) * 0.2, g: glow };
      };
    case 'marble':
      return (u, v) => {
        const n = pfbm(u, v, PX, PY, seed, 6);
        const vein = Math.pow(Math.abs(Math.sin((u * PX + v * PY * 0.5 + n * 5) * Math.PI)), 0.35);
        return { t: 1 - vein, h: vein * 0.3, g: 0 };
      };
    case 'rock':
      return (u, v) => {
        const n = pfbm(u, v, PX * 2, PY * 2, seed, 6);
        const m = pfbm(u, v, PX, PY, seed + 9, 3);
        return { t: sm(0.35, 0.7, n * 0.7 + m * 0.3), h: n, g: 0 };
      };
    case 'cells':
      return (u, v) => {
        const [f1, f2] = pworley(u, v, PX * 2, PY * 2, seed);
        const edge = sm(0.0, 0.18, f2 - f1);
        return { t: 1 - edge, h: edge * (1 - f1 * 0.5), g: 0 };
      };
    case 'craters':
      return (u, v) => {
        let h = pfbm(u, v, PX * 2, PY * 2, seed, 5) * 0.4;
        for (let k = 0; k < 3; k++) {
          const sc = 2 + k * 3;
          const [f1] = pworley(u, v, PX * sc, PY * sc, seed + 100 + k);
          const r = 0.28 + hash2(k, seed, 3) * 0.1;
          const bowl = 1 - sm(0, r, f1);
          const ring = sm(r * 0.7, r, f1) * (1 - sm(r, r * 1.35, f1));
          h += (ring * 0.6 - bowl * 0.5) / (k + 1);
        }
        return { t: sm(0.2, 0.6, h + 0.3), h: h + 0.5, g: 0 };
      };
    case 'stripes':
      return (u, v) => {
        const n = pfbm(u, v, PX, PY, seed, 3);
        const s = 0.5 + 0.5 * Math.sin((u * PX * 2 + (n - 0.5) * 0.4) * Math.PI * 2);
        return { t: sm(0.4, 0.6, s), h: s * 0.2, g: 0 };
      };
    case 'checker':
      return (u, v) => {
        const c = (Math.floor(u * PX * 2) + Math.floor(v * PY * 2)) & 1;
        return { t: c, h: c * 0.1, g: 0 };
      };
    default:
      return () => ({ t: 0, h: 0, g: 0 });
  }
}

// 戻り値: { color, normal, emissive: RGBA(Uint8ClampedArray) } と幅・高さ
// image: 画像模様のとき、{ data: RGBA, width, height }（メインスレッドで読み込んだ画素）
export function generateMaterialMaps(p, width, height, image = null) {
  const aspect = width / height;
  const c1 = hexToRgb(p.color), c2 = hexToRgb(p.color2), gc = hexToRgb(p.glowColor ?? p.color2);
  const color = new Uint8ClampedArray(width * height * 4);
  const emissive = new Uint8ClampedArray(width * height * 4);
  const hgt = new Float32Array(width * height);
  const fn = patternFn(p, aspect);
  const S = Math.max(1, Math.round(p.scale));

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const o = (y * width + x) * 4;
      let r, g, b, h, glow;
      if (p.pattern === 'image' && image) {
        // 画像を周期ぶん並べる（最近傍ではなく画素中心で拾う）
        const iu = (((u * S * aspect) % 1) * image.width) | 0;
        const iv = (((v * S) % 1) * image.height) | 0;
        const io = (iv * image.width + iu) * 4;
        r = image.data[io] / 255;
        g = image.data[io + 1] / 255;
        b = image.data[io + 2] / 255;
        h = (r + g + b) / 3;
        glow = 1;
      } else {
        const s = fn(u, v);
        r = c1[0] + (c2[0] - c1[0]) * s.t;
        g = c1[1] + (c2[1] - c1[1]) * s.t;
        b = c1[2] + (c2[2] - c1[2]) * s.t;
        if (s.ice) {
          r += (0.95 - r) * s.ice;
          g += (0.97 - g) * s.ice;
          b += (1 - b) * s.ice;
        }
        h = s.h;
        glow = p.pattern === 'lava' ? s.g : 1;
      }
      color[o] = r * 255;
      color[o + 1] = g * 255;
      color[o + 2] = b * 255;
      color[o + 3] = 255;
      // 発光：溶岩は割れ目だけ、それ以外は表面の色そのものが光る（強さは素材側で決める）
      const ec = p.pattern === 'lava' ? gc : [r, g, b];
      emissive[o] = ec[0] * glow * 255;
      emissive[o + 1] = ec[1] * glow * 255;
      emissive[o + 2] = ec[2] * glow * 255;
      emissive[o + 3] = 255;
      hgt[y * width + x] = h;
    }
  }

  // 凹凸 → 法線（周期境界で中心差分）
  const normal = new Uint8ClampedArray(width * height * 4);
  const k = (p.bump ?? 0.5) * 6;
  for (let y = 0; y < height; y++) {
    const ym = (y - 1 + height) % height, yp = (y + 1) % height;
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width, xp = (x + 1) % width;
      const dx = (hgt[y * width + xp] - hgt[y * width + xm]) * k;
      const dy = (hgt[yp * width + x] - hgt[ym * width + x]) * k;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * width + x) * 4;
      // 画像の行0が上（v=1）なので、縦方向の傾きは符号を反転して接空間に合わせる
      normal[o] = (-dx / len * 0.5 + 0.5) * 255;
      normal[o + 1] = (dy / len * 0.5 + 0.5) * 255;
      normal[o + 2] = (1 / len * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return { color, normal, emissive, width, height };
}
