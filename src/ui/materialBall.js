import { generateMaterialMaps } from '../core/texgen.js';

// 素材を小さな球に描いた見本（2D canvas で簡易に陰影を付ける。WebGL は使わない）
const mapCache = new Map();

function mapsFor(m) {
  const key = JSON.stringify([m.pattern, m.color, m.color2, m.glowColor, m.scale, m.seed]);
  if (!mapCache.has(key)) {
    if (mapCache.size > 200) mapCache.clear();
    mapCache.set(key, generateMaterialMaps({ ...m, pattern: m.pattern === 'image' ? 'solid' : m.pattern }, 96, 48));
  }
  return mapCache.get(key);
}

export function drawMaterialBall(canvas, m) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const maps = mapsFor(m);
  const L = norm([-0.55, 0.6, 0.6]);
  const shin = 4 + (1 - m.roughness) * 120;
  const specAmt = 0.08 + (1 - m.roughness) * 0.7;
  const R = size / 2 - 1;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px - size / 2 + 0.5) / R;
      const y = -(py - size / 2 + 0.5) / R;
      const d2 = x * x + y * y;
      const o = (py * size + px) * 4;
      if (d2 > 1) continue;
      const z = Math.sqrt(1 - d2);
      const lon = Math.atan2(x, z) + 0.6;
      const lat = Math.asin(y);
      const u = (((lon / (Math.PI * 2) + 0.5) % 1) + 1) % 1;
      const v = 0.5 - lat / Math.PI;
      const ti = ((Math.min(maps.height - 1, (v * maps.height) | 0) * maps.width + ((u * maps.width) | 0)) * 4);
      const base = [maps.color[ti] / 255, maps.color[ti + 1] / 255, maps.color[ti + 2] / 255];
      const ndl = Math.max(0, x * L[0] + y * L[1] + z * L[2]);
      // 反射ベクトルと視線 (0,0,1)
      const rz = 2 * ndl * z - L[2];
      const spec = Math.pow(Math.max(0, rz), shin) * specAmt;
      const metal = m.metalness;
      const glow = Math.min(1, m.glow * 0.35);
      const em = [maps.emissive[ti] / 255, maps.emissive[ti + 1] / 255, maps.emissive[ti + 2] / 255];
      const fres = Math.pow(1 - z, 3);
      for (let c = 0; c < 3; c++) {
        let col = base[c] * (0.18 + 0.82 * ndl) * (1 - metal * 0.7);
        col += spec * (metal ? base[c] * 1.4 : 1);
        col += metal * base[c] * (0.25 + 0.5 * fres); // 金属は周りを映す
        col = col * (1 - m.transmission * 0.6) + m.transmission * (0.35 + fres * 0.6);
        col += em[c] * glow;
        img.data[o + c] = Math.min(255, col * 255);
      }
      // 縁をなめらかに
      img.data[o + 3] = Math.min(255, (1 - Math.sqrt(d2)) * R * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function norm(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}
