// 空の飾り（オーロラ・虹）の明るさを向きごとに求める（一枚絵の全天画像に描き込む用）。
// リアルタイム表示のシェーダ（render/Aurora.js・render/Rainbow.js）と同じ式を JavaScript にしたもの。
// 返す値は「露出をかける前の明るさ」ではなく 0..数 の相対値。呼ぶ側で露出に合わせて倍率をかける。

const fract = (x) => x - Math.floor(x);
const hash = (n) => fract(Math.sin(n) * 43758.5453);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function noise1(x) {
  const i = Math.floor(x), f = x - i;
  return hash(i) + (hash(i + 1) - hash(i)) * f * f * (3 - 2 * f);
}
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const n = ix + iy * 57;
  const a = hash(n) + (hash(n + 1) - hash(n)) * fx;
  const b = hash(n + 57) + (hash(n + 58) - hash(n + 57)) * fx;
  return a + (b - a) * fy;
}

// オーロラ：d = 向き（y = 上、-z = 北）、north = 1（北の空）/ -1（南の空）、time = 秒。out に RGB を足す
export function addAurora(d, north, time, out, k = 1) {
  const el = Math.asin(Math.max(-1, Math.min(1, d[1])));
  if (el < -0.02) return;
  let hx = d[0], hy = -d[2] * north;
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl;
  hy /= hl;
  const az = Math.atan2(hx, hy);
  // 下の縁はほぼ同じ高さ（上空約 100 km）にそろい、細かく折れ曲がる（大きくうねらせると V 字の山のように見える）
  // 大きなうねりは控えめに（強いと、下の縁が遠くの山の稜線のように見えた）。細かい折れ目を主に
  const wave = noise1(az * 2 + time * 0.03) * 0.025 + noise1(az * 7 - time * 0.05) * 0.03 + noise1(az * 19 + time * 0.08) * 0.015;
  // 下の縁：北の空に東西へのびる帯を下から見上げた形。真北で最も高く、東西へ離れるほど遠くなって地平線へ下がる（仰角 = atan(tan(h) cos(方位))）
  const base = Math.atan(Math.tan(0.16 + wave) * Math.max(0.05, Math.cos(az)));
  const above = el - base;
  // 下の縁はくっきりと明るく（電子が最も深く降りる所。実際のオーロラは縁がいちばん明るい）、上へ薄れていく
  const up = Math.max(above, 0);
  let band = smooth(-0.008, 0, above) * (Math.exp(-up * 4) + 0.7 * Math.exp(-up * 45));
  band *= smooth(1.9, 0.6, Math.abs(az));
  if (band < 1e-4) return;
  let rays = noise2(az * 40 + time * 0.25, above * 2) * 0.6 + noise2(az * 110 - time * 0.4, 0) * 0.4;
  rays = 0.35 + 0.9 * rays * rays;
  const pulse = 0.6 + 0.4 * noise1(az * 3 + time * 0.2);
  const a = band * rays * pulse * smooth(-0.02, 0.05, el) * k;
  const t = smooth(0.05, 0.35, above), w = smooth(0.02, -0.02, above) * 0.5;
  for (let i = 0; i < 3; i++) {
    let c = [0.15, 1.0, 0.45][i] + ([0.75, 0.25, 0.6][i] - [0.15, 1.0, 0.45][i]) * t;
    c += ([0.6, 1.0, 0.75][i] - c) * w;
    out[i] += c * a;
  }
}

function spectrum(t, out) {
  out[0] = Math.min(1, Math.max(0, 1 - smooth(0.25, 0.5, t) + smooth(0.85, 1, t) * 0.5));
  out[1] = Math.min(1, Math.max(0, smooth(0.1, 0.35, t) * (1 - smooth(0.55, 0.8, t))));
  out[2] = Math.min(1, Math.max(0, smooth(0.5, 0.75, t)));
  return out;
}

// 虹：d = 向き、antiSun = 太陽と反対の向き。out に RGB を足す
export function addRainbow(d, antiSun, out, k = 1) {
  const c = Math.max(-1, Math.min(1, d[0] * antiSun[0] + d[1] * antiSun[1] + d[2] * antiSun[2]));
  const ang = (Math.acos(c) * 180) / Math.PI;
  if (ang < 14 || ang > 56) return;
  const t1 = (42.4 - ang) / 2;
  const b1 = smooth(-0.15, 0.1, t1) * (1 - smooth(0.9, 1.15, t1));
  const t2 = (ang - 50) / 3.3;
  const b2 = smooth(-0.15, 0.1, t2) * (1 - smooth(0.9, 1.15, t2)) * 0.35;
  const inner = (1 - smooth(30, 40.5, ang)) * smooth(15, 30, ang) * 0.06;
  const s1 = spectrum(Math.min(1, Math.max(0, t1)), [0, 0, 0]);
  const s2 = spectrum(Math.min(1, Math.max(0, t2)), [0, 0, 0]);
  const hz = smooth(-0.01, 0.06, d[1]);
  // 弧に沿った明るさのむら（雨の濃さの違い）：反太陽点のまわりの角度で
  const ax = Math.abs(antiSun[1]) < 0.99 ? [antiSun[2], 0, -antiSun[0]] : [1, 0, 0];
  const az = Math.atan2(d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2], d[1] - antiSun[1] * c);
  const vary = 0.55 + 0.45 * noise1(az * 3 + 11) * (0.6 + 0.4 * noise1(az * 9 + 3));
  for (let i = 0; i < 3; i++) {
    // 実際の虹は淡い：純色を白へ 35% 寄せる
    const p1 = s1[i] * 0.65 + 0.35 * (s1[0] + s1[1] + s1[2]) / 3;
    const p2 = s2[i] * 0.65 + 0.35 * (s2[0] + s2[1] + s2[2]) / 3;
    out[i] += (p1 * b1 + p2 * b2 * 0.6 + inner) * hz * vary * k;
  }
}
