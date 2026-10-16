// 星の丸み（CPU 版）。render/curvatureGLSL.js の kCurve / kCurveN と同じ式。
// 平らな地図の点を、中心 (cx, cz) を基準に半径 R の球面へ曲げる（正距方位図法の逆）。R が 0 なら何もしない。

export function curvePoint(x, y, z, cx, cz, R, out = [0, 0, 0]) {
  const rx = x - cx, rz = z - cz;
  const d = Math.hypot(rx, rz);
  if (!(R > 0) || d < 1e-3) {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }
  const th = d / R, s = Math.sin(th / 2), rh = R + y;
  out[0] = cx + (rx / d) * rh * Math.sin(th);
  out[1] = y * Math.cos(th) - 2 * R * s * s;
  out[2] = cz + (rz / d) * rh * Math.sin(th);
  return out;
}

// 面の向き (nx, ny, nz) を、点 (x, z) の位置で同じだけ傾ける
export function curveNormal(x, z, nx, ny, nz, cx, cz, R, out = [0, 0, 0]) {
  const rx = x - cx, rz = z - cz;
  const d = Math.hypot(rx, rz);
  if (!(R > 0) || d < 1e-3) {
    out[0] = nx; out[1] = ny; out[2] = nz;
    return out;
  }
  const th = d / R, c = Math.cos(th), s = Math.sin(th);
  const ux = rx / d, uz = rz / d;
  const a = nx * ux + nz * uz; // 中心から外向きの成分
  const restX = nx - ux * a, restZ = nz - uz * a; // 横向きの成分（そのまま）
  out[0] = restX + ux * c * a + ux * s * ny;
  out[1] = -s * a + c * ny;
  out[2] = restZ + uz * c * a + uz * s * ny;
  return out;
}

// 一枚絵の海の円盤（StillRenderer の curvedDisc）の作り方と、そのたわみ。
// 円盤は中心から外へ、半径 × (DISC_RATIO − 1) ずつの同心円と、一周 DISC_SEG 分割の三角形でできている。
// 平らな三角形は球面より内側にたわむので、その深さ（弦のたわみ L²/8R）を見積もる
export const DISC_RATIO = 1.03;
export const DISC_SEG = 720;
export function discSag(r, R) {
  if (!(R > 0)) return 0;
  const L = Math.max(r * (DISC_RATIO - 1), (2 * Math.PI * r) / DISC_SEG, 1);
  return (L * L) / (8 * R);
}

// 平らな三角形（一辺 L）でできた地形も球面より内側にたわむ。陸の頂点をその分だけ持ち上げ、
// 遠くの低い海岸が海面の下へ沈んで縞にならないようにする（対角線ぶん √2 倍で見積もる）
export function landLift(y, spacing, level, R) {
  if (!(R > 0) || y < level) return y;
  const L = spacing * 1.42;
  return y + (L * L) / (8 * R);
}

// 水の下の地形は、海面のたわみより深くしておく（浅瀬が水面から顔を出したり、水深のむらが縞に見えたりしないように）
export function belowWater(y, d, level, R) {
  return y < level ? Math.min(y, level - 0.5 - discSag(d, R) * 1.2) : y;
}
