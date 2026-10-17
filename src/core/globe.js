// 地球モードの計算（Three.js も DOM も使わない）。
//
// 地球中心の座標（ECEF。Three.js に合わせて Y = 北極）：
//   x = cosφ cosλ、y = sinφ、z = −cosφ sinλ（φ = 緯度、λ = 経度）
// 地表の区画は標高タイル（Web メルカトルの z/x/y）そのものを四分木の節にする。
// メルカトルが届かない極（緯度 ±85.05° より先）は、ふたのような面で閉じる。
import { EARTH_R } from './geo.js';

export const GLOBE_R = EARTH_R;
export const MERC_MAX_LAT = 85.05112878;
export const GLOBE_MAX_ZOOM = 15; // 標高タイルのいちばん細かいズーム（約 5 m / 画素）
// 地表の色（衛星写真）。遠く（ズーム 7 まで）は NASA Blue Marble、近く（ズーム 8〜14）は Sentinel-2 cloudless。
//   Blue Marble Next Generation：GIBS で公開、パブリックドメイン。雲の無い合成写真、約 600 m / 画素
//   Sentinel-2 cloudless 2016：EOX が公開（CC BY 4.0）。雲の無い合成写真、約 10 m / 画素
export const IMAGERY_MAX_ZOOM = 14;
export const IMAGERY_FAR_MAX_ZOOM = 7;
export const IMAGERY_FAR_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
export const IMAGERY_NEAR_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
// 雲の少ない新しい版（2023 年）。ライセンスは CC BY-NC-SA 4.0（非商用・継承）なので、選んだときだけ使う
export const IMAGERY_RECENT_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg';
export const IMAGERY_RECENT_ATTRIBUTION =
  'NASA Blue Marble Next Generation（NASA GIBS）、Sentinel-2 cloudless 2023 – https://s2maps.eu by EOX IT Services GmbH（Contains modified Copernicus Sentinel data 2023、CC BY-NC-SA 4.0）';
// 取り込み画面で「雲の少ない新しい衛星写真」を選んでいるか（地球モードの地表もそれに合わせる）
export function prefersRecentPhoto() {
  try {
    return localStorage.getItem('kuniumi.photo.recent') === '1';
  } catch {
    return false;
  }
}
export const IMAGERY_ATTRIBUTION =
  'NASA Blue Marble Next Generation（NASA GIBS）、Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH（Contains modified Copernicus Sentinel data 2016）';
// 夜の街の明かり：NASA Black Marble（VIIRS、2016 年。GIBS で公開、パブリックドメイン）
export const LIGHTS_MAX_ZOOM = 8;
export const LIGHTS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
export const LIGHTS_ATTRIBUTION = 'NASA Black Marble（VIIRS、NASA GIBS）';
// ズーム a の写真の URL
export const imageryUrl = (a, x, y, recent = false) => (a <= IMAGERY_FAR_MAX_ZOOM ? IMAGERY_FAR_URL : recent ? IMAGERY_RECENT_URL : IMAGERY_NEAR_URL).replace('{z}', a).replace('{x}', x).replace('{y}', y);
export const lightsUrl = (a, x, y) => LIGHTS_URL.replace('{z}', a).replace('{x}', x).replace('{y}', y);
export const GRID = 32; // 区画 1 つの格子の分割数（頂点は 33 × 33）
const D2R = Math.PI / 180;

// 経緯度（度）と地球中心からの距離 → ECEF
export function ecef(lat, lon, r = GLOBE_R, out = [0, 0, 0]) {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p);
  out[0] = r * c * Math.cos(l);
  out[1] = r * Math.sin(p);
  out[2] = -r * c * Math.sin(l);
  return out;
}

// ECEF → 経緯度（度）と地球中心からの距離
export function toLatLon(x, y, z) {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / (r || 1)))) / D2R, lon: Math.atan2(-z, x) / D2R, r };
}

// その場所の東・北・上（単位ベクトル）
export function enu(lat, lon) {
  const p = lat * D2R, l = lon * D2R;
  const sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
  return {
    east: [-sl, 0, -cl],
    north: [-sp * cl, cp, sp * sl],
    up: [cp * cl, sp, -cp * sl],
  };
}

// メルカトルのタイル行（0..1 の割合、0 = 北の端）⇔ 緯度
export const mercYToLat = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) / D2R;
export const latToMercY = (lat) => {
  const p = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) * D2R;
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2;
};

// タイル (z, x, y) の中の割合 (u, v) の経緯度
export function tileLatLon(z, x, y, u, v) {
  const n = 2 ** z;
  return { lat: mercYToLat((y + v) / n), lon: ((x + u) / n) * 360 - 180 };
}

// タイルの四隅の経緯度と、地表での一辺のおよその長さ（m。中ほどの緯度で）
export function tileInfo(z, x, y) {
  const n = 2 ** z;
  const north = mercYToLat(y / n), south = mercYToLat((y + 1) / n);
  const west = (x / n) * 360 - 180, east = ((x + 1) / n) * 360 - 180;
  const midLat = mercYToLat((y + 0.5) / n);
  const width = (2 * Math.PI * GLOBE_R * Math.cos(midLat * D2R)) / n;
  return { north, south, west, east, midLat, midLon: (west + east) / 2, width };
}

// タイルを包む球（ECEF の中心と半径）。標高の幅 [hMin, hMax] (m) を含める
export function tileBounds(z, x, y, hMin = -11000, hMax = 9000) {
  const pts = [];
  for (const v of [0, 0.5, 1]) {
    for (const u of [0, 0.5, 1]) {
      const p = tileLatLon(z, x, y, u, v);
      pts.push(ecef(p.lat, p.lon, GLOBE_R + hMin), ecef(p.lat, p.lon, GLOBE_R + hMax));
    }
  }
  // 大きなタイル（ズーム 0〜1）は面が丸く膨らむので、中ほどの点も足す
  if (z < 3) {
    for (let k = 1; k < 8; k++) {
      for (const [u, v] of [[k / 8, 0.5], [0.5, k / 8], [k / 8, k / 8], [k / 8, 1 - k / 8]]) {
        const p = tileLatLon(z, x, y, u, v);
        pts.push(ecef(p.lat, p.lon, GLOBE_R + hMax));
      }
    }
  }
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return { center: c, radius: r };
}

// 地平線の向こうに隠れているか（海面の球を遮るものとみなす。控えめに：少しでも見えうるなら false）
export function behindHorizon(cam, center, radius, R = GLOBE_R) {
  const dc = Math.hypot(...cam);
  if (dc <= R) return false;
  const hCam = Math.sqrt(dc * dc - R * R);
  const top = Math.hypot(...center) + radius;
  const hObj = top > R ? Math.sqrt(top * top - R * R) : 0;
  const d = Math.hypot(cam[0] - center[0], cam[1] - center[1], cam[2] - center[2]) - radius;
  return d > hCam + hObj;
}

// 「見ている所（地表の点）・そこからの距離・向き・傾き」からカメラの位置と上の向き（ECEF）
//   heading: 0 = 北を向く（時計回り、度）、tilt: 0 = 真下を見る、90 = 水平（度）
export function orbitCamera({ lat, lon, range, heading, tilt }, groundH = 0) {
  const f = enu(lat, lon);
  const t = ecef(lat, lon, GLOBE_R + groundH);
  const H = heading * D2R, T = tilt * D2R;
  const fwd = [0, 1, 2].map((k) => f.north[k] * Math.cos(H) + f.east[k] * Math.sin(H));
  const back = [0, 1, 2].map((k) => f.up[k] * Math.cos(T) - fwd[k] * Math.sin(T));
  const pos = [0, 1, 2].map((k) => t[k] + back[k] * range);
  const up = [0, 1, 2].map((k) => fwd[k] * Math.cos(T) + f.up[k] * Math.sin(T));
  return { pos, target: t, up };
}

// 太陽の真下の点（実際の日時から。均時差は無視、精度は 1° 程度）
export function subsolarPoint(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (day + 10));
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -(hours - 12) * 15;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: decl, lon };
}

// 区画の格子（(GRID+1)²、行 0 = 北）を 256 × 256 の標高から取る。縁はタイルの端ちょうど
export function sampleGrid(heights, size = 256, n = GRID + 1) {
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const py = Math.max(0, Math.min(size - 1, (j / (n - 1)) * size - 0.5));
    const y0 = Math.min(size - 2, Math.floor(py)), fy = py - y0;
    for (let i = 0; i < n; i++) {
      const px = Math.max(0, Math.min(size - 1, (i / (n - 1)) * size - 0.5));
      const x0 = Math.min(size - 2, Math.floor(px)), fx = px - x0;
      const a = heights[y0 * size + x0], b = heights[y0 * size + x0 + 1];
      const c = heights[(y0 + 1) * size + x0], d = heights[(y0 + 1) * size + x0 + 1];
      out[j * n + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// 区画の格子から、その場所 (u, v ∈ 0..1) の標高
export function gridAt(grid, u, v, n = GRID + 1) {
  const x = Math.max(0, Math.min(n - 1, u * (n - 1))), y = Math.max(0, Math.min(n - 1, v * (n - 1)));
  const x0 = Math.min(n - 2, Math.floor(x)), y0 = Math.min(n - 2, Math.floor(y)), fx = x - x0, fy = y - y0;
  const a = grid[y0 * n + x0], b = grid[y0 * n + x0 + 1], c = grid[(y0 + 1) * n + x0], d = grid[(y0 + 1) * n + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// 経緯度 → そのズームのタイル番号と、タイルの中の割合
export function locateTile(lat, lon, z) {
  const n = 2 ** z;
  const fx = (((lon + 180) / 360) % 1 + 1) % 1 * n;
  const fy = Math.max(0, Math.min(n - 1e-9, latToMercY(lat) * n));
  const x = Math.min(n - 1, Math.floor(fx)), y = Math.floor(fy);
  return { x, y, u: fx - x, v: fy - y };
}

// タイル (z, x, y) の中で、祖先のタイル（ズーム a）の画像のどこを使うか：{ x, y } タイルと、その中の [ox, oy, scale]
export function ancestorXf(z, x, y, a) {
  const k = z - a, n = 2 ** k;
  const s = 1 / n;
  return { x: x >> k, y: y >> k, ox: (x % n) * s, oy: (y % n) * s, scale: s };
}

// 取り込み範囲の大きさ（m）：見ている距離から。細かく見ているほど狭く
export function importSizeFor(range) {
  return Math.max(4000, Math.min(3000e3, range * 1.6));
}
