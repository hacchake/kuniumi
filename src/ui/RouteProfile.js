import { t } from '../i18n/index.js';

// 経路の断面図（標高グラフ）：横が経路に沿った距離、縦が地形の標高。いまいる所に印。
// 歩いている間、経路があれば画面の左下に。登りの合計・下りの合計・全長も出す。
const N = 240; // 標高を拾う点の数

export class RouteProfile {
  constructor(host) {
    this.el = document.createElement('div');
    this.el.className = 'route-profile';
    this.el.hidden = true;
    this.el.innerHTML = `<canvas></canvas><div class="rp-info"></div>`;
    host.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.info = this.el.querySelector('.rp-info');
    this.prof = null;
  }

  // pts: [{ x, z }]（平らな地図の座標）、groundAt(x, z)。null で消す
  set(pts, groundAt) {
    this.prof = null;
    if (!pts || pts.length < 2) return this.show(false);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = cum[cum.length - 1];
    const ys = [];
    let j = 1;
    for (let k = 0; k < N; k++) {
      const s = (k / (N - 1)) * total;
      while (j < cum.length - 1 && cum[j] < s) j++;
      const u = Math.max(0, Math.min(1, (s - cum[j - 1]) / Math.max(1e-6, cum[j] - cum[j - 1])));
      ys.push(groundAt(pts[j - 1].x + (pts[j].x - pts[j - 1].x) * u, pts[j - 1].z + (pts[j].z - pts[j - 1].z) * u));
    }
    let up = 0, down = 0;
    for (let k = 1; k < N; k++) {
      const d = ys[k] - ys[k - 1];
      if (d > 0) up += d;
      else down -= d;
    }
    this.prof = { pts, cum, total, ys, min: Math.min(...ys), max: Math.max(...ys) };
    const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    this.info.textContent = `${km(total)}　↑${Math.round(up)} m　↓${Math.round(down)} m　${t('最高')} ${Math.round(this.prof.max)} m`;
  }

  show(on) {
    this.el.hidden = !on || !this.prof;
  }

  // いまいる所（平らな地図の座標）。経路にいちばん近い所に印をつける
  draw(px, pz) {
    if (this.el.hidden || !this.prof) return;
    const { pts, cum, total, ys, min, max } = this.prof;
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.el.clientWidth, H = 64;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height, pad = 4 * dpr;
    const span = Math.max(10, max - min);
    const X = (k) => pad + (k / (N - 1)) * (w - 2 * pad);
    const Y = (y) => h - pad - ((y - min) / span) * (h - 2 * pad);
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(X(0), h);
    ys.forEach((y, k) => ctx.lineTo(X(k), Y(y)));
    ctx.lineTo(X(N - 1), h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 122, 60, 0.28)';
    ctx.fill();
    ctx.beginPath();
    ys.forEach((y, k) => (k ? ctx.lineTo(X(k), Y(y)) : ctx.moveTo(X(k), Y(y))));
    ctx.strokeStyle = '#ff9a5c';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    // いまいる所：経路の上でいちばん近い点の距離
    let best = Infinity, s = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / L));
      const d = Math.hypot(a.x + dx * u - px, a.z + dz * u - pz);
      if (d < best) (best = d), (s = cum[i - 1] + u * (cum[i] - cum[i - 1]));
    }
    if (best < 100) {
      const k = (s / total) * (N - 1);
      const y = ys[Math.min(N - 1, Math.round(k))];
      ctx.fillStyle = '#ffdf8a';
      ctx.strokeStyle = '#1a1206';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(X(k), Y(y), 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
