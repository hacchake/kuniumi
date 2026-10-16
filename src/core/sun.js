// 太陽と大気の計算（Three.js 非依存）。
// 座標系: Y が上、北 = -Z、東 = +X（glTF と同じ。Blender では北 = +Y、東 = +X になる）

import { skyParams, skyRadiance, sunIrradiance } from './skyModel.js';

const D2R = Math.PI / 180;

// 地面から太陽へ向かう単位ベクトル
// 夜の明るさ（月明かり・星明かりの近似）の度合い：太陽が沈むほど 1 に近づく
export function nightFactor(elevation) {
  const t = Math.min(1, Math.max(0, (2 - elevation) / 12));
  return t * t * (3 - 2 * t);
}
// 夜の空の光の色と明るさ（放射輝度。物理的な昼の空の 1 万分の 1 程度を、見える明るさまで持ち上げたもの）
export const NIGHT_SKY = [0.15, 0.2, 0.36];

export function sunDirection(elevationDeg, azimuthDeg) {
  const e = elevationDeg * D2R;
  const a = azimuthDeg * D2R;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

export function anglesFromDirection([x, y, z]) {
  const len = Math.hypot(x, y, z) || 1;
  const elevation = Math.asin(y / len) / D2R;
  let azimuth = Math.atan2(x, -z) / D2R;
  if (azimuth < 0) azimuth += 360;
  return { elevation, azimuth };
}

// 日光（平行光源）の色と強さ、遠景のかすみの色は、空の物理モデル（skyModel.js）から求める。
// リアルタイム表示と静止画（空そのものを光源にする）で、太陽と空の明るさの釣り合いをそろえるため。

// 太陽の放射照度（法線入射、線形 RGB）。強さ = 最大成分、色 = それで割った値
export function sunLight(sun, atmosphere) {
  const dir = sunDirection(sun.elevation, sun.azimuth);
  const p = skyParams(atmosphere, dir);
  const e = sunIrradiance(p).map((v) => v * sun.intensity);
  const strength = Math.max(...e);
  const color = strength > 0 ? e.map((v) => v / strength) : [1, 1, 1];
  return { color, strength, dir };
}

// 遠景のかすみの色（線形 RGB）。地平線すぐ上の空の明るさを全方位で平均したもの
export function hazeColor(sun, atmosphere) {
  const p = skyParams(atmosphere, sunDirection(sun.elevation, sun.azimuth));
  const sum = [0, 0, 0], c = [0, 0, 0];
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    skyRadiance(p, [Math.cos(a) * 0.9987, 0.05, Math.sin(a) * 0.9987], c, { sunDisc: false, clouds: false });
    for (let k = 0; k < 3; k++) sum[k] += c[k] / n;
  }
  return sum;
}

// 実際の太陽の位置：緯度・経度（度）と日時から、高度と方位（北から東回り、度）。精度は 1° 未満（NOAA の略式）
export function solarPosition(lat, lon, date = new Date()) {
  const R = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * R;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
  const eps = (23.439 - 0.0000004 * n) * R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = ((((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24) * 15;
  const H = (gmst + lon) * R - ra;
  const p = lat * R;
  const el = Math.asin(Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(H));
  let az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(p) - Math.sin(p) * Math.cos(H)) / R;
  az = ((az % 360) + 360) % 360;
  return { elevation: el / R, azimuth: az };
}

// 月齢（日、0 = 新月 … 約 14.8 = 満月 … 29.53）。2000-01-06 18:14 UTC の新月から朔望月で数える（誤差は半日ほど）
export const SYNODIC_MONTH = 29.530588;
export function moonAge(date = new Date()) {
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  return ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
}

// 月の光っている割合（0 = 新月、1 = 満月）
export function moonIllumination(age) {
  return (1 - Math.cos((age / SYNODIC_MONTH) * Math.PI * 2)) / 2;
}

// 月の向き（y = 上の単位ベクトル。x = 東、z = 南）：太陽の向きから、月齢の分だけ天球上を東へ離した所。
// 黄道の代わりに「太陽を通り、真上より南へ傾いた所（中緯度の黄道の高さ）を通る大円」の上で回す近似。
// 満月は太陽のほぼ反対、上弦は日没のころ南の空の高い所、下弦は夜明けのころ南の空。
export function moonDirection(sunDir, age) {
  const S = norm(sunDir);
  const top = norm([0, 1, 0.7]); // 大円が通る「南寄りの天頂」
  let A = cross(S, top);
  if (Math.hypot(...A) < 1e-4) A = [1, 0, 0];
  A = norm(A);
  const th = (age / SYNODIC_MONTH) * Math.PI * 2;
  const c = Math.cos(th), s = Math.sin(th);
  const AxS = cross(A, S), d = dot3(A, S);
  return [0, 1, 2].map((k) => S[k] * c + AxS[k] * s + A[k] * d * (1 - c));
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
