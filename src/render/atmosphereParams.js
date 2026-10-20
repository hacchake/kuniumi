import { sunDirection, hazeColor } from '../core/sun.js';
import { skyParams, sunIrradiance, skyRadiance } from '../core/skyModel.js';

// シーン JSON から、雲と霧の計算に渡す値を組み立てる（一枚絵・リアルタイム表示で共通）
// 厚い雲に覆われた空の光の灰色の度合い（0..1）：雲の量 0.65 から効き始め、全天の雲で 0.85
export function overcastAmount(a) {
  const t = Math.min(1, Math.max(0, ((a.clouds ?? 0) - 0.65) / 0.35));
  return t * t * (3 - 2 * t) * 0.85;
}

// 色 c を、明るさを保ったまま、やや青みの灰色へ k だけ寄せる（曇天の光）
export function toOvercast(c, k) {
  if (k <= 0) return c;
  const L = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const g = [L * 0.95, L, L * 1.08];
  return c.map((v, i) => v + (g[i] - v) * k);
}

// 霧や雲に当たる空の光の色：地平線近くの空の平均だけだと、朝夕はオレンジ一色になり霧が泥のような茶色になる。
// 実際の霧は青い天頂を含む空全体から光を受けるので、明るさは地平線の平均のまま、色合いを空全体（上半球）の平均と半々に
function skyAmbient(s, a) {
  const horizon = hazeColor(s.sun, a);
  const p = skyParams(a, sunDirection(s.sun.elevation, s.sun.azimuth));
  const dome = [0, 0, 0], c = [0, 0, 0];
  let w = 0;
  for (let j = 0; j < 6; j++) {
    const el = ((j + 0.5) / 6) * (Math.PI / 2);
    const ce = Math.cos(el), se = Math.sin(el);
    for (let i = 0; i < 12; i++) {
      const az = (i / 12) * Math.PI * 2;
      skyRadiance(p, [Math.cos(az) * ce, se, Math.sin(az) * ce], c, { sunDisc: false, clouds: false });
      for (let k = 0; k < 3; k++) dome[k] += c[k] * ce; // 立体角の重み
      w += ce;
    }
  }
  const lum = (v) => v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  const ld = lum(dome) / w, lh = lum(horizon);
  if (!(ld > 0) || !(lh > 0)) return horizon;
  // 空全体の色を地平線の明るさにそろえて、半々に混ぜる
  return horizon.map((v, k) => v * 0.5 + (dome[k] / w) * (lh / ld) * 0.5);
}

export function atmosphereParams(s) {
  const a = s.atmosphere;
  const sunDir = sunDirection(s.sun.elevation, s.sun.azimuth);
  const p = skyParams(a, sunDir);
  return {
    sunDir,
    sunE: sunIrradiance(p).map((v) => v * s.sun.intensity),
    // 霧や雲に当たる空の光：地平線近くの空の明るさ
    // 厚い雲の下では、雲を通った光で灰色に
    ambient: toOvercast(skyAmbient(s, a).map((v) => v * a.ambient * 0.8), overcastAmount(a)),
    fog: {
      density: a.haze * 1e-4,
      height: a.fogHeight,
      base: s.water.enabled ? s.water.level : s.terrain.baseHeight,
      g: a.rays,
      maxDist: Math.max(40000, s.terrain.size * 5),
    },
    clouds: {
      coverage: a.clouds,
      density: a.cloudDensity,
      scale: a.cloudScale,
      elevation: a.cloudElevation,
      base: a.cloudAltitude,
      thickness: a.cloudThickness,
    },
    skyP: p,
  };
}
