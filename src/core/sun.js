// 太陽と大気の計算（Three.js 非依存）。
// 座標系: Y が上、北 = -Z、東 = +X（glTF と同じ。Blender では北 = +Y、東 = +X になる）

const D2R = Math.PI / 180;

// 地面から太陽へ向かう単位ベクトル
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

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp3 = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);

// 日光の色（線形RGB）と強さ。低い太陽ほど赤く、地平線の下では消える
export function sunLight(elevationDeg, intensity = 1) {
  const warm = [1.0, 0.45, 0.2];
  const noon = [1.0, 0.96, 0.9];
  const color = lerp3(warm, noon, smooth(-2, 35, elevationDeg));
  const strength = 3.2 * intensity * smooth(-3, 6, elevationDeg);
  return { color, strength };
}

// 遠景のかすみの色（線形RGB）。空の地平線付近の色の近似
export function hazeColor(elevationDeg, rayleigh = 2) {
  const night = [0.01, 0.015, 0.03];
  const dusk = [0.55, 0.32, 0.22];
  const day = [0.45 - rayleigh * 0.03, 0.58 - rayleigh * 0.01, 0.75];
  let c = lerp3(dusk, day, smooth(2, 30, elevationDeg));
  c = lerp3(night, c, smooth(-8, 2, elevationDeg));
  return c;
}
