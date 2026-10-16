import { createTerrainShader } from './terrainColor.js';
import { curvePoint, curveNormal, belowWater, landLift } from './curvature.js';
import { PHOTO_ALBEDO } from '../io/photo.js';

// 一枚絵用の「周りの地形」（地球から取り込んだ範囲の外側）のメッシュ。Three.js 非依存。
// meters: 標高 (m) の格子（res × res、行 0 = 北）、size: 一辺 (m)。
// 本来の地形が受け持つ内側（一辺 innerSize）にすっぽり入るマスは作らない。
// place: { ox, oz, cx, cz, R } 原点のずらしと星の丸み（terrainLod.js と同じ）
// photo: 周りの地形の衛星写真があるか（あれば色は写真のテクスチャで貼る。頂点の色は明るさの倍率だけ）
// 戻り値の uvs は (i, 1 − j)（北 = v 1。地形の本体と同じ向き）
export function buildSurroundMesh(meters, res, size, { innerSize, terrain, water, place, maxRes = 1025, photo = null }) {
  // 粗くてよいので間引く
  const step = Math.max(1, Math.ceil((res - 1) / (maxRes - 1)));
  const n = Math.floor((res - 1) / step) + 1;
  const cell = (size / (res - 1)) * step;
  const at = (i, j) => meters[Math.min(res - 1, j * step) * res + Math.min(res - 1, i * step)];
  const shade = createTerrainShader({
    heightScale: terrain.heightScale,
    baseHeight: terrain.baseHeight,
    waterLevel: water.level,
    waterEnabled: water.enabled,
    palette: terrain.palette,
    vegetation: null,
    realWorld: true,
  });
  const P = place;
  const pcx = P.cx - P.ox, pcz = P.cz - P.oz;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const pp = [0, 0, 0], pn = [0, 0, 0], col = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * size, z = (j / (n - 1) - 0.5) * size;
      const y = at(i, j);
      const gx = (at(Math.min(n - 1, i + 1), j) - at(Math.max(0, i - 1), j)) / (2 * cell);
      const gz = (at(i, Math.min(n - 1, j + 1)) - at(i, Math.max(0, j - 1))) / (2 * cell);
      const nl = Math.hypot(gx, 1, gz);
      const k = (j * n + i) * 3;
      const lvl = water.enabled ? water.level : -Infinity;
      const yy = P.R > 0 ? landLift(water.enabled ? belowWater(y, Math.hypot(x - P.cx, z - P.cz), water.level, P.R) : y, cell, lvl, P.R) : y;
      curvePoint(x - P.ox, yy, z - P.oz, pcx, pcz, P.R, pp);
      curveNormal(x - P.ox, z - P.oz, -gx / nl, 1 / nl, -gz / nl, pcx, pcz, P.R, pn);
      positions.set(pp, k);
      normals.set(pn, k);
      shade(y, Math.hypot(gx, gz), 0, 0, col);
      if (photo && !(water.enabled && y < water.level)) col[0] = col[1] = col[2] = PHOTO_ALBEDO;
      uvs[(j * n + i) * 2] = i / (n - 1);
      uvs[(j * n + i) * 2 + 1] = 1 - j / (n - 1);
      colors.set(col, k);
    }
  }
  const half = innerSize / 2;
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const x0 = (i / (n - 1) - 0.5) * size, z0 = (j / (n - 1) - 0.5) * size;
      // 内側に完全に入るマスは本来の地形に任せる
      if (x0 >= -half && x0 + cell <= half && z0 >= -half && z0 + cell <= half) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { positions, normals, colors, uvs, index: new Uint32Array(idx) };
}
