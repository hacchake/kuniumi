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
