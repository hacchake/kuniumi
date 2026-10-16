// 地球の上の範囲 ⇔ KUNIUMI の大地。公開されている標高タイルから高さ場を作るための計算（Three.js も DOM も使わない）。
//
// 大地の座標：x = 東、z = 南（北 = −Z）、中心 (0, 0)。高さ場の行 0 が北の端。
// 地球の上へは「正距方位図法」で対応させる：中心から各点までの距離と方位を、そのまま大地の上の距離と方位にする。
// 描くときの丸み（curvatureGLSL.js）も同じ図法の逆なので、取り込んだ大陸を丸く描くと元の地球の形に戻る。

export const EARTH_R = 6371000;
export const TILE = 256;
export const MAX_ZOOM = 15;

// 標高タイル（Mapzen Terrain Tiles。AWS Open Data で公開。SRTM・GMTED・ETOPO1・NED などを合成、海底地形も含む）
// terrarium 形式：標高(m) = R×256 + G + B/256 − 32768
export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const ELEVATION_ATTRIBUTION = 'Mapzen Terrain Tiles（AWS Open Data）: SRTM, GMTED2010, ETOPO1, NED ほか';

export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

const D2R = Math.PI / 180;

// 経緯度 → タイル座標（小数。Web メルカトル）
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n,
  };
}

export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / D2R;
  return { lon, lat };
}

// 正距方位図法の逆：中心 (lat0, lon0) から東へ e、北へ n (m) の点の経緯度
export function aeqdInverse(e, n, lat0, lon0, R = EARTH_R) {
  const rho = Math.hypot(e, n);
  if (rho < 1e-6) return { lat: lat0, lon: lon0 };
  const c = rho / R;
  const p0 = lat0 * D2R, sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(Math.max(-1, Math.min(1, cc * Math.sin(p0) + (n * sc * Math.cos(p0)) / rho)));
  const lon = lon0 * D2R + Math.atan2(e * sc, rho * Math.cos(p0) * cc - n * Math.sin(p0) * sc);
  let L = lon / D2R;
  L = ((((L + 180) % 360) + 360) % 360) - 180;
  return { lat: lat / D2R, lon: L };
}

// 正距方位図法：経緯度 → 中心から東 e・北 n (m)
export function aeqdForward(lat, lon, lat0, lon0, R = EARTH_R) {
  const p = lat * D2R, p0 = lat0 * D2R, dl = (lon - lon0) * D2R;
  const cc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, cc)));
  const k = c < 1e-12 ? 1 : c / Math.sin(c);
  return {
    e: R * k * Math.cos(p) * Math.sin(dl),
    n: R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl)),
  };
}

// 大地の格子点 (i, j)（res × res、行 0 = 北）の経緯度
export function gridLonLat(i, j, res, region) {
  const e = (i / (res - 1) - 0.5) * region.size;
  const n = (0.5 - j / (res - 1)) * region.size;
  return aeqdInverse(e, n, region.lat, region.lon);
}

// 格子の細かさに合うタイルのズーム（取り寄せる枚数が maxTiles を超えないよう粗くする）
export function chooseZoom(region, res, maxTiles = 400) {
  const cell = region.size / (res - 1);
  const coslat = Math.max(0.05, Math.cos(region.lat * D2R));
  let z = Math.ceil(Math.log2((2 * Math.PI * EARTH_R * coslat) / (TILE * cell)));
  z = Math.max(0, Math.min(MAX_ZOOM, z));
  while (z > 0 && tilesFor(region, z).length > maxTiles) z--;
  return z;
}

// 範囲を覆うタイルの一覧（縁と対角を細かくたどって、メルカトル上の外形から求める）
export function tilesFor(region, z) {
  const n = 2 ** z;
  const seen = new Set();
  const out = [];
  const add = (lon, lat) => {
    const t = lonLatToTile(lon, lat, z);
    const tx = ((Math.floor(t.x) % n) + n) % n, ty = Math.max(0, Math.min(n - 1, Math.floor(t.y)));
    const key = `${tx}/${ty}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ x: tx, y: ty, z });
    }
  };
  // 範囲の中を、タイルより細かい間隔で標本して、触れるタイルを集める
  const tileM = (2 * Math.PI * EARTH_R * Math.max(0.05, Math.cos(region.lat * D2R))) / n;
  const steps = Math.max(8, Math.min(600, Math.ceil((region.size / tileM) * 3)));
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const p = gridLonLat(i, j, steps + 1, region);
      add(p.lon, p.lat);
    }
  }
  return out;
}

// 範囲の目安の大きさ（km）を、地名検索の結果の外枠（南, 北, 西, 東）から
export function sizeFromBBox(south, north, west, east) {
  const a = aeqdForward(south, west, (south + north) / 2, (west + east) / 2);
  const b = aeqdForward(north, east, (south + north) / 2, (west + east) / 2);
  return Math.max(Math.abs(b.e - a.e), Math.abs(b.n - a.n));
}

// よく使う範囲のひな形（中心・一辺 km・解像度）
export const GEO_PRESETS = [
  { name: '日本列島', lat: 36.0, lon: 137.0, size: 3000, res: 4097 },
  { name: '本州', lat: 36.3, lon: 138.4, size: 1300, res: 4097 },
  { name: '北海道', lat: 43.4, lon: 142.8, size: 600, res: 2049 },
  { name: '九州', lat: 32.6, lon: 130.8, size: 450, res: 2049 },
  { name: '富士山と周辺', lat: 35.36, lon: 138.73, size: 60, res: 2049 },
  { name: '北アルプス', lat: 36.35, lon: 137.65, size: 90, res: 2049 },
  { name: '北アメリカ大陸', lat: 45, lon: -100, size: 7000, res: 4097 },
  { name: '南アメリカ大陸', lat: -20, lon: -60, size: 7500, res: 4097 },
  { name: 'ヨーロッパ', lat: 50, lon: 12, size: 4500, res: 4097 },
  { name: 'アフリカ大陸', lat: 2, lon: 18, size: 8000, res: 4097 },
  { name: 'オーストラリア大陸', lat: -26, lon: 134, size: 4500, res: 4097 },
  { name: 'ヒマラヤ山脈', lat: 28.6, lon: 85, size: 1500, res: 4097 },
  { name: 'アルプス山脈', lat: 46.2, lon: 9.6, size: 700, res: 2049 },
  { name: 'グランドキャニオン', lat: 36.1, lon: -112.1, size: 60, res: 2049 },
  { name: 'ハワイ島', lat: 19.6, lon: -155.5, size: 200, res: 2049 },
  { name: 'アイスランド', lat: 64.9, lon: -18.7, size: 600, res: 2049 },
  { name: 'ニュージーランド', lat: -41, lon: 173, size: 1600, res: 4097 },
];

// 高ズームの標高タイルは、沿岸の海が 0 m 付近の平らな値になっていて海底の深さが入っていないことがある。
// 粗いズームの「周りの地形」（ETOPO1 などの海底地形が入っている）で、範囲の海の部分を補う。
// inner: 範囲の標高 (m)、res × res・一辺 size。outer: 同じ中心の周りの地形、ores × ores・一辺 osize
export function fillSeaFloor(inner, res, size, outer, ores, osize) {
  const out = new Float32Array(inner);
  const k = size / osize;
  for (let j = 0; j < res; j++) {
    const v = (0.5 + (j / (res - 1) - 0.5) * k) * (ores - 1);
    const j0 = Math.min(ores - 2, Math.max(0, Math.floor(v))), fy = v - j0;
    for (let i = 0; i < res; i++) {
      const h = inner[j * res + i];
      if (h > 0 || h < -40) continue; // 陸地と、もともと深さの入っている海はそのまま
      const u = (0.5 + (i / (res - 1) - 0.5) * k) * (ores - 1);
      const i0 = Math.min(ores - 2, Math.max(0, Math.floor(u))), fx = u - i0;
      const a = outer[j0 * ores + i0], b = outer[j0 * ores + i0 + 1], c = outer[(j0 + 1) * ores + i0], d = outer[(j0 + 1) * ores + i0 + 1];
      const o = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      // 粗いデータでは海岸近くが陸の値になるので、そこは浅瀬（−1.5 m）にとどめる
      out[j * res + i] = Math.min(h, o < -2 ? o : -1.5);
    }
  }
  return out;
}

// 範囲の縁（一辺の frac の幅）を、周りの地形の高さへ滑らかに寄せる。
// 縁ではちょうど周りの地形と同じ高さになるので、細かい地形と粗い地形の境目に段差や崖ができない
export function featherToSurround(inner, res, size, outer, ores, osize, frac = 0.03) {
  const out = new Float32Array(inner);
  const k = size / osize;
  const sm = (x) => x * x * (3 - 2 * x);
  for (let j = 0; j < res; j++) {
    const fj = j / (res - 1);
    const v = (0.5 + (fj - 0.5) * k) * (ores - 1);
    const j0 = Math.min(ores - 2, Math.max(0, Math.floor(v))), fy = v - j0;
    for (let i = 0; i < res; i++) {
      const fi = i / (res - 1);
      const e = Math.min(fi, 1 - fi, fj, 1 - fj);
      if (e >= frac) continue;
      const u = (0.5 + (fi - 0.5) * k) * (ores - 1);
      const i0 = Math.min(ores - 2, Math.max(0, Math.floor(u))), fx = u - i0;
      const a = outer[j0 * ores + i0], b = outer[j0 * ores + i0 + 1], c = outer[(j0 + 1) * ores + i0], d = outer[(j0 + 1) * ores + i0 + 1];
      const o = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      const w = sm(e / frac);
      out[j * res + i] = o + (inner[j * res + i] - o) * w;
    }
  }
  return out;
}
