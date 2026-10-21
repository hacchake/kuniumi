// 月面図：実際の月の表側の配置をまねた、明るさ（アルベド）と凹凸の地図。
// 暗い「海」（雨の海・晴れの海・静かの海・危難の海・豊かの海・神酒の海・雲の海・湿りの海・嵐の大洋・氷の海 ほか）を
// 実際の月面の緯度経度に置き、明るい高地には大小のクレーター、ティコ・コペルニクス・ケプラー・アリスタルコスには
// 明るい光条をつける。空の月（リアルタイム表示・一枚絵）と、物体の素材「月」が同じ地図を使う。
//
// moonMap(): { W, H, albedo: Float32Array, height: Float32Array }（等距円筒、行 0 = 北緯 90°、列 0 = 西経 180°）。
// albedo は高地の明るさを 1 とした相対値（海はおよそ 0.55）。一度作れば使い回す
// moonAt(lat, lon): 緯度・経度（ラジアン、東経が正）の { a: 明るさ, h: 凹凸 }（双一次補間）

const W = 1024, H = 512;
const R = 1737; // 月の半径 (km)

// 海：[緯度, 経度, 半径 km, 横長さ（経度方向の倍率）]
const MARIA = [
  [18, -57, 900, 0.75], // 嵐の大洋（南北に長い）
  [33, -16, 560, 1], // 雨の海
  [28, 17, 330, 1], // 晴れの海
  [8.5, 31, 430, 1], // 静かの海
  [17, 59, 280, 1.25], // 危難の海
  [-8, 51, 400, 0.8], // 豊かの海
  [-15, 35, 170, 1], // 神酒の海
  [-21, -17, 360, 1], // 雲の海
  [-24, -39, 200, 1], // 湿りの海
  [-10, -23, 180, 1], // 知られた海
  [7, -31, 260, 1], // 島の海
  [13, 4, 130, 1], // 蒸気の海
  [2, 1, 110, 1.2], // 中央の入江
  [-28, -6, 120, 1], // 雲の海の南
  [10, -48, 360, 0.8], // 嵐の大洋（南）
  [35, -45, 350, 0.9], // 嵐の大洋（北）
  [40, 23, 120, 1], // 晴れの海の北
];
// 氷の海：北緯 56° に東西へ細長く
for (let lon = -40; lon <= 40; lon += 20) MARIA.push([55 + Math.sin(lon * 0.1) * 2, lon, 150, 2.2]);

// 光条のある若いクレーター：[緯度, 経度, 半径 km, 光条の長さ km, 強さ]
const RAYED = [
  [-43.3, -11.2, 43, 1500, 1], // ティコ
  [9.6, -20.1, 47, 600, 0.45], // コペルニクス
  [8.1, -38, 16, 400, 0.55], // ケプラー
  [23.7, -47.4, 20, 250, 0.9], // アリスタルコス（月でいちばん明るい所）
  [-8.9, 61.1, 11, 300, 0.45], // ラングレヌス近くの明るい点
];

const fract = (x) => x - Math.floor(x);
// 整数の格子点の乱数（0..1）。Math.sin を使う式より何倍も速い（月面図は数十万画素 × 百回ほど呼ぶ）
function h3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul((s * 97) | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise3(x, y, z, s) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (a, b, cc) => h3(ix + a, iy + b, iz + cc, s);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}
function fbm3(x, y, z, s, oct) {
  let v = 0, a = 0.5, f = 1;
  for (let o = 0; o < oct; o++) {
    v += vnoise3(x * f, y * f, z * f, s + o) * a;
    a *= 0.5;
    f *= 2;
  }
  return v;
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const toVec = (latDeg, lonDeg) => {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
};

let cache = null;
export function moonMap() {
  if (cache) return cache;
  const albedo = new Float32Array(W * H), height = new Float32Array(W * H);
  // 半径は少し大きめに（実際の海は縁で隣どうしつながり、表側の大きな暗い模様になる）
  const maria = MARIA.map(([la, lo, r, ex]) => ({ c: toVec(la, lo), lon: (lo * Math.PI) / 180, lat: (la * Math.PI) / 180, ang: (r * 1.25) / R, ex }));
  const rayed = RAYED.map(([la, lo, r, len, k]) => ({ c: toVec(la, lo), ang: r / R, len: len / R, k, seed: la * 7 + lo }));
  // クレーター：大きさの段ごとに、球面の 3 次元格子の各升に 1 つまで（若いものほど少なく大きく明るい）
  const SCALES = [
    { f: 5, p: 0.55, rmin: 0.05, rmax: 0.11, s: 11 },
    { f: 11, p: 0.6, rmin: 0.04, rmax: 0.09, s: 23 },
    { f: 24, p: 0.65, rmin: 0.035, rmax: 0.08, s: 37 },
    { f: 50, p: 0.7, rmin: 0.03, rmax: 0.07, s: 53 },
  ];
  for (let j = 0; j < H; j++) {
    const lat = Math.PI / 2 - ((j + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), y = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * Math.PI * 2 - Math.PI;
      const p = [cl * Math.sin(lon), y, cl * Math.cos(lon)];
      // 海の濃さ：中心からの角距離を半径で割った値。縁は大きなノイズで入り組ませる
      // 海の縁を入り組ませる：位置を大きなノイズでずらしてから、海の中心との距離を測る。重なる海は溶け合わせる
      const wx = (fbm3(p[0] * 2.5 + 7, p[1] * 2.5, p[2] * 2.5, 3, 4) - 0.5) * 0.35;
      const wy = (fbm3(p[0] * 2.5, p[1] * 2.5 + 7, p[2] * 2.5, 4, 4) - 0.5) * 0.35;
      const wob = (fbm3(p[0] * 7, p[1] * 7, p[2] * 7, 5, 4) - 0.5) * 0.9;
      const e0 = 0.62 + wob * 0.5, e1 = 1.08 + wob * 0.5;
      const wlon = lon + wx / Math.max(0.2, cl), wlat = lat + wy;
      let dry = 1;
      for (const m of maria) {
        let dl = wlon - m.lon;
        if (dl > Math.PI) dl -= Math.PI * 2;
        else if (dl < -Math.PI) dl += Math.PI * 2;
        dl *= cl / m.ex;
        const dp = wlat - m.lat;
        const d2 = (dl * dl + dp * dp) / (m.ang * m.ang);
        if (d2 >= e1 * e1) continue;
        dry *= smooth(e0, e1, Math.sqrt(d2));
      }
      const mare = 1 - dry;
      // 高地の明るさのむら、海の中の濃淡（溶岩の流れの違い）
      const hn = fbm3(p[0] * 6, p[1] * 6, p[2] * 6, 9, 5);
      const mn = fbm3(p[0] * 9, p[1] * 9, p[2] * 9, 13, 4);
      // 高地は明るさのむらが大きく、海は場所ごとに濃さが違う（縁ほどやや明るい）
      let a = (0.78 + hn * 0.45) * (1 - mare) + (0.4 + mn * 0.3 + (1 - mare) * 0.15) * mare;
      let h = (hn - 0.5) * 0.4 * (1 - mare * 0.7);
      // クレーター（海の中は溶岩に埋もれて少ない）
      for (const sc of SCALES) {
        const q = [p[0] * sc.f, p[1] * sc.f, p[2] * sc.f];
        const bx = Math.floor(q[0]), by = Math.floor(q[1]), bz = Math.floor(q[2]);
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cx = bx + dx, cy = by + dy, cz = bz + dz;
              const e = h3(cx, cy, cz, sc.s);
              if (e > sc.p * (1 - mare * 0.75)) continue;
              const ox = cx + h3(cx, cy, cz, sc.s + 1), oy = cy + h3(cx, cy, cz, sc.s + 2), oz = cz + h3(cx, cy, cz, sc.s + 3);
              const r = (sc.rmin + (sc.rmax - sc.rmin) * Math.pow(h3(cx, cy, cz, sc.s + 4), 3)) * 1.7;
              const d = Math.hypot(q[0] - ox, q[1] - oy, q[2] - oz) / r;
              if (d > 2.2) continue;
              const fresh = h3(cx, cy, cz, sc.s + 5); // 新しいクレーターほど縁と噴出物が明るい
              const bowl = 1 - smooth(0.0, 0.85, d);
              const rim = Math.exp(-((d - 0.95) ** 2) / 0.02);
              const ejecta = d > 1 ? Math.exp(-(d - 1) * 3) * (1 - smooth(1.8, 2.2, d)) : 0;
              a *= 1 - 0.16 * bowl + (0.14 * rim + 0.2 * ejecta * fresh * fresh) * (0.5 + fresh);
              h += (-bowl * 0.5 + rim * 0.25) * r * 2;
            }
      }
      // 光条：若いクレーターから放射状にのびる明るい筋
      for (const c of rayed) {
        const cd = Math.min(1, Math.max(-1, p[0] * c.c[0] + p[1] * c.c[1] + p[2] * c.c[2]));
        const psi = Math.acos(cd);
        if (psi > c.len * 1.1) continue;
        // クレーターのまわりの方位角
        const up = Math.abs(c.c[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
        const e1 = norm(cross(up, c.c)), e2 = cross(c.c, e1);
        const az = Math.atan2(p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2], p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2]);
        const t = psi / c.len;
        let ray = 0;
        for (let k = 0; k < 3; k++) {
          const nA = vnoise3(Math.cos(az) * (6 + k * 9), Math.sin(az) * (6 + k * 9), c.seed + k, 71);
          ray += Math.pow(nA, 4 + k * 3) * (1 - k * 0.25);
        }
        // 筋はクレーターの噴出物の外から始まり、淡く遠くまで（中心に集まる星形にしない）
        const halo = Math.exp(-((psi / c.ang) ** 2) / 4) * 0.35;
        a *= 1 + c.k * (ray * 0.55 * (1 - smooth(0.1, 1.0, t)) * smooth(1.5, 4, psi / c.ang) + halo);
      }
      albedo[j * W + i] = a;
      height[j * W + i] = h;
    }
  }
  cache = { W, H, albedo, height };
  return cache;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// 緯度・経度（ラジアン、東経が正）の明るさと凹凸
export function moonAt(lat, lon) {
  const m = moonMap();
  const x = ((lon + Math.PI) / (Math.PI * 2)) * m.W - 0.5;
  const y = ((Math.PI / 2 - lat) / Math.PI) * m.H - 0.5;
  const x0 = Math.floor(x), y0 = Math.min(m.H - 2, Math.max(0, Math.floor(y)));
  const tx = x - x0, ty = Math.min(1, Math.max(0, y - y0));
  const xi = (k) => ((k % m.W) + m.W) % m.W;
  const s = (arr) => {
    const a = arr[y0 * m.W + xi(x0)], b = arr[y0 * m.W + xi(x0 + 1)], c = arr[(y0 + 1) * m.W + xi(x0)], d = arr[(y0 + 1) * m.W + xi(x0 + 1)];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  return { a: s(m.albedo), h: s(m.height) };
}

