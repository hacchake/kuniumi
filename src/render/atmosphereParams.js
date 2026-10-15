import { sunDirection, hazeColor } from '../core/sun.js';
import { skyParams, sunIrradiance } from '../core/skyModel.js';

// シーン JSON から、雲と霧の計算に渡す値を組み立てる（一枚絵・リアルタイム表示で共通）
export function atmosphereParams(s) {
  const a = s.atmosphere;
  const sunDir = sunDirection(s.sun.elevation, s.sun.azimuth);
  const p = skyParams(a, sunDir);
  return {
    sunDir,
    sunE: sunIrradiance(p).map((v) => v * s.sun.intensity),
    // 霧や雲に当たる空の光：地平線近くの空の明るさ
    ambient: hazeColor(s.sun, a).map((v) => v * a.ambient * 0.8),
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
