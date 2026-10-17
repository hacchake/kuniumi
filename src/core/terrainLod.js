import { createTerrainSurface } from './terrainSurface.js';
import { PHOTO_ALBEDO } from '../io/photo.js';
import { createTerrainShader, valueNoise } from './terrainColor.js';
import { createVegetationRules, placeVegetation } from './vegetation.js';
import { curvePoint, curveNormal, belowWater, landLift } from './curvature.js';

// 静止画用の地形：カメラに近いほど細かい区画（四分木）に分け、地形の高さを直接計算して作る（ノイズ地形・ハイトマップ地形の両方）。
// 格子の地形は遠景には十分だが、近景では 1 マス数 m の多角形が角張って見える。
// ノイズは手続き的なので、近くの区画では数十 cm 間隔・設定より細かいオクターブまで描ける。
//
// 区画の境目は細かさが違うと段差ができるので、細かい区画の縁を隣の粗い区画の縁（直線）に合わせて縫い合わせる。
// 色は頂点ごとに塗る（近いほど頂点が細かいので、近景ほど色も細かくなる）。

const N = 64; // 区画 1 枚あたりの分割数

// view: { position:[x,y,z], target:[x,y,z], fov(度), aspect, height(px) }
// 戻り値: { positions, normals, colors, uvs, index, tiles, triangles }
// vegetation: シーンの植生設定（森の色づけと、木・草の配置に使う）
// heightmapImage: ハイトマップ地形のときの解釈済み画像 { data, width, height }
// place: { ox, oz, cx, cz, R } 書き出す座標の原点 (ox, oz) と、星の丸みの中心 (cx, cz)・半径 R（どれも世界座標）。
//   数千 km の大地でも Float32 の精度を落とさないよう、原点を注視点へずらしてから丸みで曲げる
// photo: 地表の衛星写真の画素 { data, width, height }（あれば色と木の広がりに使う）
export function buildLodTerrain(terrain, water, view, { maxTriangles = 4_000_000, onProgress, vegetation, heightmapImage = null, place = null, photo = null, refField = null } = {}) {
  const P = place ?? { ox: 0, oz: 0, cx: 0, cz: 0, R: 0 };
  const pcx = P.cx - P.ox, pcz = P.cz - P.oz;
  const pp = [0, 0, 0], pn = [0, 0, 0];
  const { size, heightScale, baseHeight } = terrain;

  const surface = createTerrainSurface(terrain, heightmapImage, water?.enabled ? water.level : null, refField);
  const { heightAt, wearAt } = surface;

  // ---- 四分木で区画を決める ----
  const C = view.position;
  const tgt = view.target;
  const fwd = norm([tgt[0] - C[0], tgt[1] - C[1], tgt[2] - C[2]]);
  const halfV = ((view.fov / 2) * Math.PI) / 180;
  const halfDiag = Math.atan(Math.tan(halfV) * Math.hypot(1, view.aspect));
  const pixel = (2 * Math.tan(halfV)) / view.height; // 1 画素の角度（おおよそ）
  const yLo = baseHeight, yHi = baseHeight + heightScale;
  // 丸い星では、地平線より向こう（いちばん高い山でも隠れる距離）の区画は作らない
  const horizon = P.R > 0 ? (Math.sqrt(2 * P.R * Math.max(1, C[1] - Math.min(0, yLo))) + Math.sqrt(2 * P.R * Math.max(0, yHi))) * 1.05 : Infinity;

  const collect = (detail) => {
    const tiles = [];
    const visit = (x0, z0, L, depth) => {
      // 区画の箱までの距離（高さは地形の全範囲）
      const dx = Math.max(x0 - C[0], 0, C[0] - (x0 + L));
      const dz = Math.max(z0 - C[2], 0, C[2] - (z0 + L));
      const dy = Math.max(yLo - C[1], 0, C[1] - yHi);
      const d = Math.max(1, Math.hypot(dx, dy, dz));
      if (Math.hypot(dx, dz) > horizon) return;
      // 視野に入っているか（中心方向と視線の角度、区画の見かけの大きさを足して判定）
      const cx = x0 + L / 2 - C[0], cz = z0 + L / 2 - C[2], cy = (yLo + yHi) / 2 - C[1];
      const cd = Math.hypot(cx, cy, cz) || 1;
      const ang = Math.acos(Math.min(1, (cx * fwd[0] + cy * fwd[1] + cz * fwd[2]) / cd));
      const radius = Math.atan((L * 0.75 + heightScale * 0.5) / cd);
      const inView = ang - radius < halfDiag * 1.15;
      // 頂点の間隔が、画面上で detail 画素くらいになるまで分ける（視野の外は粗くてよい）
      const target = (inView ? detail : detail * 40) * pixel;
      const split = L / N / d > target && L / N > 0.15 && depth < 18;
      if (split) {
        const h = L / 2;
        visit(x0, z0, h, depth + 1);
        visit(x0 + h, z0, h, depth + 1);
        visit(x0, z0 + h, h, depth + 1);
        visit(x0 + h, z0 + h, h, depth + 1);
      } else {
        tiles.push([x0, z0, L]);
      }
    };
    visit(-size / 2, -size / 2, size, 0);
    return tiles;
  };
  // 三角形の数が上限に収まるよう、細かさを調整する
  const triPerTile = N * N * 2;
  let detail = 1.5;
  let tiles = collect(detail);
  while (tiles.length * triPerTile > maxTriangles && detail < 64) {
    detail *= 1.35;
    tiles = collect(detail);
  }

  // ---- 区画ごとに形と色を作る ----
  const vertsPerTile = (N + 1) * (N + 1);

  // 葉の区画の一覧（大きさと左上の座標）から、ある地点を含む区画の大きさを引けるようにする
  const leafKey = (L, x0, z0) => `${L}|${x0}|${z0}`;
  const leaves = new Set(tiles.map(([x0, z0, L]) => leafKey(L, x0, z0)));
  const leafSizeAt = (x, z, minL) => {
    for (let S = minL; S <= size * 1.0001; S *= 2) {
      const x0 = -size / 2 + Math.floor((x + size / 2) / S) * S;
      const z0 = -size / 2 + Math.floor((z + size / 2) / S) * S;
      if (leaves.has(leafKey(S, x0, z0))) return S;
    }
    return 0;
  };
  const minL = Math.min(...tiles.map((t) => t[2]));
  // 区画の角の高さ：その角に接する区画のうち最も粗いものの細かさで計算する（どの区画から見ても同じ値になる）
  const cornerCache = new Map();
  const cornerHeight = (x, z) => {
    const key = `${x}|${z}`;
    let h = cornerCache.get(key);
    if (h === undefined) {
      const e = minL * 0.25;
      const S = Math.max(leafSizeAt(x - e, z - e, minL), leafSizeAt(x + e, z - e, minL), leafSizeAt(x - e, z + e, minL), leafSizeAt(x + e, z + e, minL));
      h = heightAt(x, z, (S || minL) / N);
      cornerCache.set(key, h);
    }
    return h;
  };
  // 粗い区画（大きさ Ln）の縁の頂点の高さ。その区画の角なら角の規則で
  const coarseVertex = (x, z, Ln) => {
    const onCorner = (v) => Math.abs(((v + size / 2) / Ln) - Math.round((v + size / 2) / Ln)) < 1e-9;
    return onCorner(x) && onCorner(z) ? cornerHeight(x, z) : heightAt(x, z, Ln / N);
  };
  // 粗い区画の縁と同じ高さ：粗い頂点（間隔 Ln/N）の高さを直線で結んだもの
  const stitched = (x, z, alongX, Ln) => {
    const sc = Ln / N;
    const t = alongX ? x : z;
    const a = -size / 2 + Math.floor((t + size / 2) / sc + 1e-9) * sc;
    const f = (t - a) / sc;
    const hA = alongX ? coarseVertex(a, z, Ln) : coarseVertex(x, a, Ln);
    if (f < 1e-6) return hA;
    const hB = alongX ? coarseVertex(a + sc, z, Ln) : coarseVertex(x, a + sc, Ln);
    return hA + (hB - hA) * f;
  };
  const total = tiles.length * vertsPerTile;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const index = new Uint32Array(tiles.length * triPerTile * 3);
  const shade = createTerrainShader({
    heightScale,
    baseHeight,
    waterLevel: water.level,
    waterEnabled: water.enabled,
    palette: terrain.palette,
    vegetation,
    realWorld: terrain.mode === 'heightmap' && !!terrain.heightmap?.geo,
  });
  const col = [0, 0, 0];
  const G = N + 3; // 法線用に 1 マス外側も計算する
  const hg = new Float32Array(G * G);
  let vo = 0, io = 0;

  tiles.forEach(([x0, z0, L], ti) => {
    const s = L / N;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) hg[j * G + i] = heightAt(x0 + (i - 1) * s, z0 + (j - 1) * s, s);
    }
    // 4 辺の隣が自分より粗ければ、その辺の頂点を粗い区画の縁に合わせる
    const eps = s * 0.5;
    const nb = {
      n: leafSizeAt(x0 + L / 2, z0 - eps, L),
      s: leafSizeAt(x0 + L / 2, z0 + L + eps, L),
      w: leafSizeAt(x0 - eps, z0 + L / 2, L),
      e: leafSizeAt(x0 + L + eps, z0 + L / 2, L),
    };
    const first = vo;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = x0 + i * s, z = z0 + j * s;
        const k = (j + 1) * G + (i + 1);
        let y = hg[k];
        if ((i === 0 || i === N) && (j === 0 || j === N)) y = cornerHeight(x, z);
        else if (j === 0 && nb.n > L) y = stitched(x, z, true, nb.n);
        else if (j === N && nb.s > L) y = stitched(x, z, true, nb.s);
        else if (i === 0 && nb.w > L) y = stitched(x, z, false, nb.w);
        else if (i === N && nb.e > L) y = stitched(x, z, false, nb.e);
        const gx = (hg[k + 1] - hg[k - 1]) / (2 * s);
        const gz = (hg[k + G] - hg[k - G]) / (2 * s);
        const nl = Math.hypot(gx, 1, gz);
        // 丸い星では、水の下の地形を海面の円盤のたわみより深くする
        const lvl = water.enabled ? water.level : -Infinity;
        // 持ち上げる量は、カメラからの距離で決まる頂点の間隔の見積もり（区画の境目で食い違わないように連続的に）
        const sEst = Math.hypot(x - C[0], y - C[1], z - C[2]) * detail * pixel * 2;
        const yy = P.R > 0 ? landLift(water.enabled ? belowWater(y, Math.hypot(x - P.cx, z - P.cz), water.level, P.R) : y, sEst, lvl, P.R) : y;
        curvePoint(x - P.ox, yy, z - P.oz, pcx, pcz, P.R, pp);
        curveNormal(x - P.ox, z - P.oz, -gx / nl, 1 / nl, -gz / nl, pcx, pcz, P.R, pn);
        positions.set(pp, vo * 3);
        normals.set(pn, vo * 3);
        uvs.set([x / size + 0.5, 0.5 - z / size], vo * 2);
        // 色のゆらぎ：大きな斑から足元の細かいムラまで（世界座標の値ノイズ）
        const jitter =
          (valueNoise(x / 64, z / 64, 11) - 0.5) * 0.6 +
          (valueNoise(x / 8, z / 8, 18) - 0.5) * 0.22 +
          (valueNoise(x / 2, z / 2, 25) - 0.5) * 0.12 +
          (valueNoise(x / 0.5, z / 0.5, 32) - 0.5) * 0.06;
        shade(y, Math.hypot(gx, gz), wearAt(x, z), jitter, col, x, z);
        // 衛星写真があれば、色は写真のテクスチャ（一枚絵の材質の map。uv で貼る）から。
        // 頂点の色は明るさの倍率と細かい色むらだけ（頂点ごとに写真を拾うと、遠くの粗い区画で写真がぼやけるため）
        if (photo && !(water.enabled && y < water.level)) {
          const k = PHOTO_ALBEDO * (1 + jitter * 0.35);
          col[0] = col[1] = col[2] = k;
        }
        colors.set(col, vo * 3);
        vo++;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = first + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        index[io++] = a; index[io++] = c; index[io++] = b;
        index[io++] = b; index[io++] = c; index[io++] = d;
      }
    }
    if (onProgress && ti % 16 === 0) onProgress(ti / tiles.length);
  });

  // ---- 木と草 ----
  let plants = null;
  if (vegetation) {
    const rules = createVegetationRules({ heightScale, baseHeight, waterLevel: water.level, waterEnabled: water.enabled, palette: terrain.palette, vegetation, realWorld: terrain.mode === 'heightmap' && !!terrain.heightmap?.geo, photo, size });
    plants = placeVegetation(rules, size, surface.coarse, (x, z) => heightAt(x, z, 0.5), view);
    // 木・草・岩の根元の位置も同じように移して曲げる（幹の傾きは近くでは無視できる）
    for (const list of [plants.conifer, plants.broadleaf, plants.grass, plants.rocks]) {
      for (let k = 0; k < list.length; k += 5) {
        curvePoint(list[k] - P.ox, list[k + 1], list[k + 2] - P.oz, pcx, pcz, P.R, pp);
        list[k] = pp[0];
        list[k + 1] = pp[1];
        list[k + 2] = pp[2];
      }
    }
  }

  // カメラの真下の地面（一枚絵の細かい地面。カメラが埋もれないか確かめる）
  const camGround = heightAt(C[0], C[2], 0.5);
  return { positions, normals, colors, uvs, index, tiles: tiles.length, triangles: io / 3, detail, plants, camGround };
}

function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}
