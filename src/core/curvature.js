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
